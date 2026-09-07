#!/usr/bin/env python3
"""第一服务研发小组审核系统 v1.1 — 任务管理 + 审核日志 + 分页 + 增强Dashboard + WebSocket直连 + DeepSeek API 回退"""

from __future__ import annotations

import concurrent.futures
import configparser
import json
import logging
import logging.handlers
import os
import re
import sqlite3
import subprocess
import sys
import time
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import hashlib
import uuid
import secrets
import threading

UI_DIR = Path(__file__).resolve().parent
BUILD = UI_DIR / "scripts" / "build_data.py"
TASK_DIR = UI_DIR / "tasks"
UPLOAD_DIR = UI_DIR / "uploads"
DB_PATH = UI_DIR / "reviews.db"
PROGRESS_DIR = UI_DIR / "progress"
LOG_DIR = UI_DIR / "logs"
HERMES_PY = Path.home() / ".hermes" / "hermes-agent" / "venv" / "bin" / "python"
AGENT_ROOT = Path.home() / ".hermes" / "hermes-agent"

# DeepSeek API 配置。密钥只能来自进程环境或权限为 0600 的本地文件，
# 禁止在源码和 systemd unit 中保留可复制的默认值。
_DS_KEY_FILE = UI_DIR / ".deepseek_key"
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "").strip()
if not DEEPSEEK_API_KEY and _DS_KEY_FILE.exists():
    DEEPSEEK_API_KEY = _DS_KEY_FILE.read_text().strip()
DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"
DEEPSEEK_MODEL = "deepseek-chat"

import rag_store

# ============================================================================
# 日志系统
# ============================================================================

LOG_DIR.mkdir(exist_ok=True)
_log_format = logging.Formatter(
    "[%(asctime)s] [%(levelname)-6s] [%(threadName)-12s] %(message)s",
    datefmt="%m-%d %H:%M:%S",
)

_console_handler = logging.StreamHandler(sys.stdout)
_console_handler.setFormatter(_log_format)
_console_handler.setLevel(logging.INFO)

_file_handler = logging.handlers.RotatingFileHandler(
    LOG_DIR / "server.log", maxBytes=5 * 1024 * 1024, backupCount=5, encoding="utf-8",
)
_file_handler.setFormatter(_log_format)
_file_handler.setLevel(logging.DEBUG)

_error_handler = logging.handlers.RotatingFileHandler(
    LOG_DIR / "error.log", maxBytes=2 * 1024 * 1024, backupCount=3, encoding="utf-8",
)
_error_handler.setFormatter(_log_format)
_error_handler.setLevel(logging.WARNING)

_logger = logging.getLogger("review-system")
_logger.setLevel(logging.DEBUG)
_logger.propagate = False
_logger.addHandler(_console_handler)
_logger.addHandler(_file_handler)
_logger.addHandler(_error_handler)

def log_info(msg: str, *args):
    _logger.info(msg, *args)

def log_warn(msg: str, *args):
    _logger.warning(msg, *args)

def log_error(msg: str, *args):
    _logger.error(msg, *args)

def log_debug(msg: str, *args):
    _logger.debug(msg, *args)

# ============================================================================
# 配置管理
# ============================================================================

CONFIG_PATH = UI_DIR / "settings.ini"
_config = configparser.ConfigParser()
if CONFIG_PATH.exists():
    _config.read(str(CONFIG_PATH))
else:
    log_warn("配置文件 %s 不存在，使用默认值", CONFIG_PATH)

def config_get(section: str, key: str, fallback: str = "") -> str:
    return _config.get(section, key, fallback=fallback) if _config.has_section(section) else fallback

def config_getint(section: str, key: str, fallback: int = 0) -> int:
    return _config.getint(section, key, fallback=fallback) if _config.has_section(section) else fallback

def config_getbool(section: str, key: str, fallback: bool = False) -> bool:
    return _config.getboolean(section, key, fallback=fallback) if _config.has_section(section) else fallback

# ============================================================================
# 速率限制
# ============================================================================

_rate_limits = {}
_rate_lock = threading.Lock()

def _get_client_ip(handler) -> str:
    forwarded = handler.headers.get("X-Forwarded-For", "")
    return forwarded.split(",")[0].strip() if forwarded else handler.client_address[0]

def check_rate_limit(handler) -> bool:
    """检查速率限制，返回 True 表示允许，False 表示拒绝"""
    if not config_getbool("rate_limit", "enabled", fallback=True):
        return True

    ip = _get_client_ip(handler)
    window = config_getint("rate_limit", "window_seconds", fallback=60)
    max_req = config_getint("rate_limit", "max_requests", fallback=120)

    now_ts = time.time()
    with _rate_lock:
        entry = _rate_limits.get(ip)
        if entry is None or (now_ts - entry["window_start"]) > window:
            _rate_limits[ip] = {"window_start": now_ts, "count": 1}
            return True

        entry["count"] += 1
        if entry["count"] > max_req:
            return False
        return True

def check_review_rate(handler) -> bool:
    """检查审核发起速率限制"""
    ip = _get_client_ip(handler)
    max_per_sec = config_getint("rate_limit", "review_max_per_second", fallback=1)
    key = f"review_{ip}"
    now_ts = time.time()
    with _rate_lock:
        entry = _rate_limits.get(key)
        if entry is None or (now_ts - entry["window_start"]) > 1.0:
            _rate_limits[key] = {"window_start": now_ts, "count": 1}
            return True
        entry["count"] += 1
        if entry["count"] > max_per_sec:
            return False
        return True

# ============================================================================
# 数据库连接
# ============================================================================

def get_db() -> sqlite3.Connection:
    """获取数据库连接（自动设置PRAGMA）"""
    conn = sqlite3.connect(str(DB_PATH), timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn

def db_close_all():
    """清理缓存（测试用）"""
    invalidate_cache()

# ============================================================================
# TTL 缓存（内存）
# ============================================================================

_cache = {}
_cache_lock = threading.Lock()

def cached(key: str, ttl: float, factory):
    """TTL 缓存：key 不变且未过期则返回缓存，否则调用 factory 刷新"""
    now_ts = time.time()
    with _cache_lock:
        entry = _cache.get(key)
        if entry and (now_ts - entry["ts"]) < ttl:
            return entry["value"]
    value = factory()
    with _cache_lock:
        _cache[key] = {"ts": time.time(), "value": value}
    return value

def invalidate_cache(pattern: str = ""):
    """清除缓存：pattern 为空则清空全部，否则删除匹配的 key"""
    with _cache_lock:
        if not pattern:
            _cache.clear()
        else:
            for k in list(_cache.keys()):
                if pattern in k:
                    del _cache[k]

# ============================================================================
# 机器人配置
# ============================================================================

PROFILES_7 = [
    {"profile": "ss-facility", "name": "科技设施专家", "role": "科技设施审核", "order": 2},
    {"profile": "kf-service", "name": "客户服务专家", "role": "客户服务审核", "order": 3},
    {"profile": "sq-community", "name": "社区经营专家", "role": "社区经营审核", "order": 4},
    {"profile": "ws-procure", "name": "五个三专家", "role": "五个三审核", "order": 5},
    {"profile": "cw-finance", "name": "计划财务专家", "role": "计划财务审核", "order": 6},
    {"profile": "xx-info", "name": "信息运营专家", "role": "信息运营审核", "order": 7},
    {"profile": "rl-hr", "name": "人力行政专家", "role": "人力行政审核", "order": 8},
]
PROFILE_TF = {"profile": "tf-invest", "name": "投资发展专家", "role": "投资发展审核", "order": 1}
PROFILES_8 = [PROFILE_TF] + PROFILES_7
WECOM_GROUP_TARGET = "wecom:wrUcOjSwAAz_uAf4IYSdkAvY0XSLcSog"
SEND_PROFILE = "tf-invest"
AGENT_SRC = AGENT_ROOT / "tools" / "send_message_tool.py"

# ============================================================================
# 审核模板库
# ============================================================================

REVIEW_TEMPLATES = [
    {
        "id": "market-selection",
        "name": "住宅物业选聘",
        "mode": "market",
        "category": "市场拓展",
        "message": "市场拓展审核：这是一个住宅物业选聘项目。\n\n项目概况：【请填写项目基本信息】\n\n请先由TF进行测算，输出成本、报价、利润判断，再组织七专业基于TF测算进行审核。",
        "requiredFiles": ["招标文件", "物业服务标准", "项目面积及人员配置"],
        "tips": "TF先行测算 → 七专业基于测算审核 → 汇总",
    },
    {
        "id": "market-office",
        "name": "写字楼/公建物业投标",
        "mode": "market",
        "category": "市场拓展",
        "message": "市场拓展审核：这是一个写字楼/公建物业投标项目。\n\n项目概况：【请填写项目基本信息】\n\n请先由TF进行测算，输出成本、报价、利润判断。",
        "requiredFiles": ["招标文件", "技术标要求", "人员配置方案", "商务标要求"],
        "tips": "TF先测算 → 七专业审核 → 汇总",
    },
    {
        "id": "market-consulting",
        "name": "顾问/授权经营项目",
        "mode": "market",
        "category": "市场拓展",
        "message": "市场拓展审核：这是一个顾问/授权经营项目。\n\n项目概况：【请填写项目概况】\n\n请先由TF进行测算，判断项目可行性。",
        "requiredFiles": ["授权/合作协议草案", "项目服务范围", "费用标准"],
        "tips": "TF先测算 → 七专业审核 → 汇总",
    },
    {
        "id": "internal-operation",
        "name": "内部运营方案",
        "mode": "internal",
        "category": "内部方案",
        "message": "内部方案审核：这是公司内部运营方案。\n\n方案概要：【请描述方案核心内容】\n\n请八个一级专业并行审核，TF只审业务价值。各专业输出本专业范围内的审核意见。",
        "requiredFiles": ["运营方案全文", "相关制度依据", "预算明细（如有）"],
        "tips": "八专业并行审核 → 自动汇总",
    },
    {
        "id": "internal-fee-adjust",
        "name": "费用调整方案",
        "mode": "internal",
        "category": "内部方案",
        "message": "内部方案审核：这是一个费用调整方案。\n\n调整内容：【请描述费用调整的具体内容和原因】\n\n请八个一级专业并行审核，重点关注财务边界、合同合规、人力成本。",
        "requiredFiles": ["费用调整方案", "现行费用标准", "调整依据文件"],
        "tips": "八专业并行审核 → 自动汇总",
    },
    {
        "id": "internal-outsource",
        "name": "外包/自建转外包方案",
        "mode": "internal",
        "category": "内部方案",
        "message": "内部方案审核：这是一个外包/自建转外包方案。\n\n外包内容：【请描述外包范围和服务内容】\n\n请八个一级专业并行审核，重点关注招采合规、人力编制、合同风险、费用测算。",
        "requiredFiles": ["外包方案", "成本对比分析", "供应商初筛名单"],
        "tips": "八专业并行审核 → 自动汇总",
    },
    {
        "id": "internal-engineering",
        "name": "工程改造方案",
        "mode": "internal",
        "category": "内部方案",
        "message": "内部方案审核：这是一个工程改造方案。\n\n改造范围：【请描述改造内容和范围】\n\n请八个一级专业并行审核，重点关注设施安全、招采合规、预算审批、工期排布。",
        "requiredFiles": ["工程改造方案", "设计图纸（如有）", "预算明细"],
        "tips": "八专业并行审核 → 自动汇总",
    },
    {
        "id": "internal-policy",
        "name": "管理制度/通知方案",
        "mode": "internal",
        "category": "内部方案",
        "message": "内部方案审核：这是一个管理制度/通知方案。\n\n制度概要：【请描述制度核心内容】\n\n请八个一级专业并行审核，重点关注合规性、可执行性、与其他制度的衔接。",
        "requiredFiles": ["制度/通知全文", "现行相关制度", "实施计划"],
        "tips": "八专业并行审核 → 自动汇总",
    },
    {
        "id": "internal-rectification",
        "name": "整改专项方案",
        "mode": "internal",
        "category": "内部方案",
        "message": "内部方案审核：这是一个整改专项方案。\n\n整改事项：【请描述整改事项和背景】\n\n请八个一级专业并行审核，重点关注整改措施的有效性、时间节点、责任部门。",
        "requiredFiles": ["整改方案", "问题清单", "整改时间表"],
        "tips": "八专业并行审核 → 自动汇总",
    },
]


def load_templates():
    """从文件加载模板，不存在则用默认值"""
    if TEMPLATES_FILE.exists():
        try:
            return json.loads(TEMPLATES_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    # 迁移默认模板到文件
    save_templates(REVIEW_TEMPLATES)
    return list(REVIEW_TEMPLATES)

def save_templates(templates):
    TEMPLATES_FILE.write_text(json.dumps(templates, ensure_ascii=False, indent=2), encoding="utf-8")

def list_templates():
    """返回模板列表"""
    return load_templates()

def add_template(data: dict) -> dict:
    templates = load_templates()
    t = {
        "id": "tpl_" + uuid.uuid4().hex[:8],
        "name": str(data.get("name", "")).strip(),
        "mode": str(data.get("mode", "internal")).strip(),
        "category": str(data.get("category", "")).strip(),
        "message": str(data.get("message", "")).strip(),
        "requiredFiles": data.get("requiredFiles", []),
        "tips": str(data.get("tips", "")).strip(),
    }
    if not t["name"] or not t["message"]:
        return {"ok": False, "error": "名称和消息内容不能为空"}
    templates.append(t)
    save_templates(templates)
    return {"ok": True, "template": t}

def update_template(tpl_id: str, data: dict) -> dict:
    templates = load_templates()
    for t in templates:
        if t["id"] == tpl_id:
            if data.get("name"): t["name"] = str(data["name"]).strip()
            if data.get("mode"): t["mode"] = str(data["mode"]).strip()
            if data.get("category"): t["category"] = str(data["category"]).strip()
            if data.get("message"): t["message"] = str(data["message"]).strip()
            if "requiredFiles" in data: t["requiredFiles"] = data["requiredFiles"]
            if data.get("tips"): t["tips"] = str(data["tips"]).strip()
            save_templates(templates)
            return {"ok": True, "template": t}
    return {"ok": False, "error": "模板不存在"}

def delete_template(tpl_id: str) -> dict:
    templates = load_templates()
    for i, t in enumerate(templates):
        if t["id"] == tpl_id:
            templates.pop(i)
            save_templates(templates)
            return {"ok": True}
    return {"ok": False, "error": "模板不存在"}


# ============================================================================
# 用户认证与权限
# ============================================================================

# 角色权限等级：数字越大权限越高
ROLE_LEVEL = {"viewer": 0, "reviewer": 1, "manager": 2, "admin": 3}

USERS_FILE = UI_DIR / "users.json"
TEMPLATES_FILE = UI_DIR / "templates.json"
DEFAULT_USERS = {
    "admin": {
        "password_hash": hashlib.sha256("admin888".encode()).hexdigest(),
        "display_name": "系统管理员",
        "role": "admin",
        "created_at": "2026-01-01",
    },
    "zhangye": {
        "password_hash": hashlib.sha256("review2026".encode()).hexdigest(),
        "display_name": "张野",
        "role": "admin",
        "created_at": "2026-01-01",
    },
    "manager": {
        "password_hash": hashlib.sha256("manager2026".encode()).hexdigest(),
        "display_name": "审核经理",
        "role": "manager",
        "created_at": "2026-01-01",
    },
    "reviewer": {
        "password_hash": hashlib.sha256("review123".encode()).hexdigest(),
        "display_name": "审核员",
        "role": "reviewer",
        "created_at": "2026-01-01",
    },
    "viewer": {
        "password_hash": hashlib.sha256("view2026".encode()).hexdigest(),
        "display_name": "访客",
        "role": "viewer",
        "created_at": "2026-01-01",
    },
}
SESSIONS = {}  # token -> user_info
SESSION_LOCK = threading.Lock()
SESSION_TTL = config_getint("auth", "token_ttl", fallback=86400)


def init_users():
    """初始化用户文件，自动迁移旧角色"""
    exist = USERS_FILE.exists()
    if not exist:
        USERS_FILE.write_text(json.dumps(DEFAULT_USERS, ensure_ascii=False, indent=2), encoding="utf-8")
        return
    try:
        users = json.loads(USERS_FILE.read_text(encoding="utf-8"))
    except Exception:
        USERS_FILE.write_text(json.dumps(DEFAULT_USERS, ensure_ascii=False, indent=2), encoding="utf-8")
        return
    changed = False
    for u, info in users.items():
        role = info.get("role", "")
        if role == "user":
            info["role"] = "reviewer"
            changed = True
        if not info.get("created_at"):
            info["created_at"] = "2026-01-01"
            changed = True
    if changed:
        USERS_FILE.write_text(json.dumps(users, ensure_ascii=False, indent=2), encoding="utf-8")
    return


def load_users() -> dict:
    """加载用户数据"""
    try:
        return json.loads(USERS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return DEFAULT_USERS


def authenticate(username: str, password: str) -> dict | None:
    """验证用户登录，成功返回用户信息和token"""
    users = load_users()
    user = users.get(username)
    if not user:
        return None
    pw_hash = hashlib.sha256(password.encode()).hexdigest()
    if pw_hash != user.get("password_hash", ""):
        return None
    token = secrets.token_hex(32)
    user_info = {
        "username": username,
        "display_name": user["display_name"],
        "role": user["role"],
    }
    with SESSION_LOCK:
        now_ts = time.time()
        expired = [t for t, s in SESSIONS.items() if now_ts - s.get("login_at", 0) > SESSION_TTL]
        for t in expired:
            del SESSIONS[t]
        SESSIONS[token] = {**user_info, "login_at": now_ts}
    return {"ok": True, "token": token, "user": user_info}


def get_session(token: str) -> dict | None:
    """获取会话信息，自动清理过期会话"""
    with SESSION_LOCK:
        sess = SESSIONS.get(token)
        if not sess:
            return None
        now_ts = time.time()
        if now_ts - sess.get("login_at", 0) > SESSION_TTL:
            del SESSIONS[token]
            return None
        return {k: v for k, v in sess.items() if k != "login_at"}


def destroy_session(token: str):
    """销毁会话"""
    with SESSION_LOCK:
        SESSIONS.pop(token, None)


def require_auth(handler) -> dict | None:
    """从请求中提取并验证token，返回user_info或None"""
    auth_header = handler.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
        return get_session(token)
    cookie = handler.headers.get("Cookie", "")
    if "auth_token=" in cookie:
        token = cookie.split("auth_token=")[1].split(";")[0].strip()
        return get_session(token)
    return None


def check_permission(user_info: dict | None, min_role: str = "viewer") -> bool:
    """检查用户权限是否达到最低角色要求
    min_role: viewer, reviewer, manager, admin
    """
    if not user_info:
        return False
    user_level = ROLE_LEVEL.get(user_info.get("role", ""), -1)
    required_level = ROLE_LEVEL.get(min_role, 99)
    return user_level >= required_level


def is_admin(user_info: dict | None) -> bool:
    """检查用户是否为管理员（兼容旧代码）"""
    return check_permission(user_info, "admin")


# ============================================================================
# 数据库设计与优化
# ============================================================================

def init_db():
    """初始化数据库：reviews 主表 + task_events 审计日志 + 索引优化 + 自动迁移"""
    db = sqlite3.connect(str(DB_PATH))
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")

    # 创建或升级 reviews 表
    existing = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='reviews'").fetchone()
    if existing:
        # 迁移旧表：添加新列（如果不存在）
        cols = [r[1] for r in db.execute("PRAGMA table_info(reviews)").fetchall()]
        migrations = {
            "status": "TEXT DEFAULT 'completed'",
            "conclusion": "TEXT DEFAULT ''",
            "reviewer_count": "INTEGER DEFAULT 0",
            "completed_count": "INTEGER DEFAULT 0",
            "source": "TEXT DEFAULT 'http'",
            "current_phase": "TEXT DEFAULT ''",
            "progress_json": "TEXT DEFAULT ''",
            "started_at": "TEXT DEFAULT ''",
            "finished_at": "TEXT DEFAULT ''",
            "failed_reason": "TEXT DEFAULT ''",
        }
        for col, defn in migrations.items():
            if col not in cols:
                db.execute(f"ALTER TABLE reviews ADD COLUMN {col} {defn}")
        # 将已有记录的 status 设为 'completed'
        db.execute("UPDATE reviews SET status='completed' WHERE status IS NULL")
        db.execute("UPDATE reviews SET reviewer_count=8 WHERE reviewer_count=0 AND mode='internal'")
        db.execute("UPDATE reviews SET reviewer_count=1 WHERE reviewer_count=0 AND mode='market'")
        db.execute("UPDATE reviews SET completed_count=sent_count WHERE completed_count=0")
    else:
        db.execute("""
            CREATE TABLE reviews (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT UNIQUE NOT NULL,
                mode TEXT NOT NULL,
                title TEXT,
                message TEXT,
                mode_label TEXT,
                status TEXT DEFAULT 'pending',
                sent_count INTEGER DEFAULT 0,
                error_count INTEGER DEFAULT 0,
                results_json TEXT,
                summary TEXT,
                conclusion TEXT,
                reviewer_count INTEGER DEFAULT 0,
                completed_count INTEGER DEFAULT 0,
                source TEXT DEFAULT 'http',
                current_phase TEXT DEFAULT '',
                progress_json TEXT DEFAULT '',
                started_at TEXT DEFAULT '',
                finished_at TEXT DEFAULT '',
                failed_reason TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT
            )
        """)

    # 创建或升级 attachments 表
    existing_att = db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='attachments'").fetchone()
    if existing_att:
        cols_att = [r[1] for r in db.execute("PRAGMA table_info(attachments)").fetchall()]
        if "content_preview" not in cols_att:
            db.execute("ALTER TABLE attachments ADD COLUMN content_preview TEXT DEFAULT ''")
    else:
        db.execute("""
            CREATE TABLE attachments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id TEXT NOT NULL,
                filename TEXT,
                stored_path TEXT,
                size INTEGER,
                content_preview TEXT,
                created_at TEXT
            )
        """)

    # 创建 task_events 表
    db.execute("""
        CREATE TABLE IF NOT EXISTS task_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            description TEXT,
            profile_code TEXT,
            metadata TEXT,
            created_at TEXT NOT NULL
        )
    """)

    # ── review_opinions：八专业逐条审核意见 ──
    db.execute("""
        CREATE TABLE IF NOT EXISTS review_opinions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            profile_code TEXT NOT NULL,
            profile_name TEXT,
            reply TEXT,
            conclusion TEXT,
            quality_score INTEGER,
            quality_level TEXT,
            quality_flags TEXT,
            wecom_sent INTEGER DEFAULT 0,
            wecom_error TEXT,
            phase TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            UNIQUE(task_id, profile_code)
        )
    """)

    # ── review_summaries：汇总意见 ──
    db.execute("""
        CREATE TABLE IF NOT EXISTS review_summaries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT UNIQUE NOT NULL,
            summary TEXT,
            conclusion TEXT,
            must_fix TEXT,
            conditional_pass TEXT,
            preconditions TEXT,
            responsible_dept TEXT,
            generated_by TEXT DEFAULT 'system',
            created_at TEXT NOT NULL,
            updated_at TEXT
        )
    """)

    # ── review_files：附件文件表 ──
    db.execute("""
        CREATE TABLE IF NOT EXISTS review_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            filename TEXT,
            stored_path TEXT,
            size INTEGER,
            file_type TEXT,
            content_preview TEXT,
            extracted_fields TEXT,
            created_at TEXT
        )
    """)

    # 索引优化
    db.execute("CREATE INDEX IF NOT EXISTS idx_reviews_task_id ON reviews(task_id)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_reviews_mode ON reviews(mode)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews(status)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_reviews_created_at ON reviews(created_at)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_attachments_task_id ON attachments(task_id)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_task_events_task_id ON task_events(task_id)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_task_events_type ON task_events(event_type)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_opinions_task_id ON review_opinions(task_id)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_opinions_profile ON review_opinions(profile_code)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_summaries_task_id ON review_summaries(task_id)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_files_task_id ON review_files(task_id)")

    db.commit()
    db.close()


def now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def safe_json_loads(raw, default=None):
    if default is None:
        default = {}
    if not raw:
        return default
    try:
        return json.loads(raw)
    except Exception:
        return default


def normalize_status(status: str) -> str:
    status = (status or "").strip().lower()
    if status == "complete":
        return "completed"
    return status or "pending"


def write_progress(task_id: str, payload: dict, sync_db: bool = True) -> dict:
    PROGRESS_DIR.mkdir(exist_ok=True)
    payload = dict(payload or {})
    payload.setdefault("taskId", task_id)
    payload["status"] = normalize_status(payload.get("status", "running"))
    payload.setdefault("updatedAt", now())
    tmp = PROGRESS_DIR / f"{task_id}.json.tmp"
    dst = PROGRESS_DIR / f"{task_id}.json"
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(dst)
    if sync_db:
        sync_review_progress(task_id, payload)
    return payload


def read_progress(task_id: str) -> dict | None:
    pf = PROGRESS_DIR / f"{task_id}.json"
    if not pf.exists():
        return None
    try:
        return json.loads(pf.read_text(encoding="utf-8"))
    except Exception as e:
        return {"ok": False, "taskId": task_id, "error": f"progress file corrupted: {e}"}


def get_task_state(task_id: str) -> dict | None:
    review = get_review(task_id)
    progress = read_progress(task_id)
    if not review and not progress:
        return None
    status = normalize_status((review or {}).get("status") or (progress or {}).get("status") or "pending")
    phase = (review or {}).get("currentPhase") or (progress or {}).get("phase") or ""
    completed = (review or {}).get("completedCount") or (progress or {}).get("completed") or 0
    total = (review or {}).get("reviewerCount") or (progress or {}).get("total") or 0
    return {
        "ok": True,
        "taskId": task_id,
        "status": status,
        "currentPhase": phase,
        "completed": completed,
        "total": total,
        "progress": progress or (review or {}).get("progress") or {},
        "review": review,
        "updatedAt": (review or {}).get("updatedAt") or (progress or {}).get("updatedAt"),
    }


def sync_review_progress(task_id: str, progress: dict) -> None:
    db = get_db()
    status = normalize_status(progress.get("status", "running"))
    phase = progress.get("phase") or progress.get("current") or ""
    completed = int(progress.get("completed") or 0)
    total = int(progress.get("total") or 0)
    failed_reason = progress.get("error", "") if status == "failed" else ""
    finished_at = now() if status in {"completed", "failed", "cancelled", "partial"} else ""
    db.execute(
        "UPDATE reviews SET status=?, current_phase=?, progress_json=?, completed_count=?, reviewer_count=CASE WHEN reviewer_count=0 THEN ? ELSE reviewer_count END, failed_reason=?, finished_at=CASE WHEN ?!='' THEN ? ELSE finished_at END, updated_at=? WHERE task_id=?",
        (status, phase, json.dumps(progress, ensure_ascii=False), completed, total, failed_reason, finished_at, finished_at, now(), task_id),
    )
    db.commit()
    db.close()
    invalidate_cache("stats_")
    invalidate_cache("analytics_")
    invalidate_cache("recent_")


def log_event(task_id: str, event_type: str, description: str = "", profile_code: str = "", metadata: dict = None):
    """记录审核任务事件（审计日志）"""
    db = get_db()
    db.execute(
        "INSERT INTO task_events (task_id, event_type, description, profile_code, metadata, created_at) VALUES(?,?,?,?,?,?)",
        (task_id, event_type, description, profile_code, json.dumps(metadata or {}, ensure_ascii=False), now()),
    )
    db.commit()
    db.close()


def save_review(task: dict):
    """保存审核任务到数据库"""
    db = get_db()
    ts = now()
    if "results" in task:
        results_payload = task.get("results")
    elif "tfResult" in task:
        results_payload = task.get("tfResult")
    else:
        results_payload = {}
    results_json = json.dumps(results_payload, ensure_ascii=False)
    status = normalize_status(task.get("status", "completed" if task.get("ok") else "failed"))
    sent_count = task.get("sentCount") or (1 if task.get("tfResult") else 0)
    reviewer_count = task.get("reviewerCount", 8 if task.get("mode") in {"internal", "market"} else 1)
    completed_count = task.get("completedCount", sent_count)
    source = task.get("source", "http")
    current_phase = task.get("currentPhase") or task.get("phase") or ("completed" if status == "completed" else status)
    progress_payload = task.get("progress") or {}
    progress_json = json.dumps(progress_payload, ensure_ascii=False) if progress_payload else task.get("progressJson", "")
    started_at = task.get("startedAt", task.get("createdAt", ts))
    finished_at = task.get("finishedAt", ts if status in {"completed", "failed", "cancelled", "partial"} else "")
    failed_reason = task.get("failedReason") or task.get("error", "")

    db.execute(
        """
        INSERT INTO reviews (task_id,mode,title,message,mode_label,status,sent_count,error_count,results_json,summary,conclusion,reviewer_count,completed_count,source,current_phase,progress_json,started_at,finished_at,failed_reason,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(task_id) DO UPDATE SET
            mode=excluded.mode,
            title=CASE WHEN excluded.title!='' THEN excluded.title ELSE reviews.title END,
            message=CASE WHEN excluded.message!='' THEN excluded.message ELSE reviews.message END,
            mode_label=excluded.mode_label,
            status=excluded.status,
            sent_count=excluded.sent_count,
            error_count=excluded.error_count,
            results_json=CASE WHEN excluded.results_json NOT IN ('{}','[]','null') THEN excluded.results_json ELSE reviews.results_json END,
            summary=CASE WHEN excluded.summary!='' THEN excluded.summary ELSE reviews.summary END,
            conclusion=CASE WHEN excluded.conclusion!='' THEN excluded.conclusion ELSE reviews.conclusion END,
            reviewer_count=excluded.reviewer_count,
            completed_count=excluded.completed_count,
            source=excluded.source,
            current_phase=excluded.current_phase,
            progress_json=CASE WHEN excluded.progress_json!='' THEN excluded.progress_json ELSE reviews.progress_json END,
            started_at=CASE WHEN reviews.started_at='' THEN excluded.started_at ELSE reviews.started_at END,
            finished_at=CASE WHEN excluded.finished_at!='' THEN excluded.finished_at ELSE reviews.finished_at END,
            failed_reason=CASE WHEN excluded.failed_reason!='' THEN excluded.failed_reason ELSE reviews.failed_reason END,
            updated_at=excluded.updated_at
        """,
        (
            task.get("taskId", ""),
            task.get("mode", ""),
            task.get("title", ""),
            task.get("message", ""),
            "内部方案" if task.get("mode") == "internal" else "市场拓展" if task.get("mode") == "market" else "未知",
            status,
            sent_count,
            task.get("errorCount", 0),
            results_json,
            task.get("summary", ""),
            task.get("conclusion", ""),
            reviewer_count,
            completed_count,
            source,
            current_phase,
            progress_json,
            started_at,
            finished_at,
            failed_reason,
            task.get("createdAt", ts),
            ts,
        ),
    )
    # 同步写入逐条审核意见（使用当前连接，避免嵌套连接冲突）
    results = task.get("results")
    if results and isinstance(results, list):
        for r in results:
            p = r.get("profile", {})
            code = p.get("profile", "")
            name = p.get("name", "")
            reply = r.get("reply", "")
            if code and reply:
                conclusion = ""
                for line in reply.splitlines()[:3]:
                    line = line.strip()
                    if any(sym in line for sym in ["✅", "⚠️", "❌"]):
                        conclusion = line[:80]
                        break
                quality = assess_reply_quality(reply)
                wecom_ok = 1 if (r.get("wecomResult") or {}).get("ok") else 0
                wecom_err = (r.get("wecomResult") or {}).get("error", "")
                db.execute(
                    """INSERT OR REPLACE INTO review_opinions
                       (task_id, profile_code, profile_name, reply, conclusion, quality_score, quality_level, quality_flags, wecom_sent, wecom_error, phase, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (task.get("taskId", ""), code, name, reply, conclusion,
                     quality["score"], quality["level"], json.dumps(quality.get("flags", []), ensure_ascii=False),
                     wecom_ok, wecom_err, r.get("phase", ""), now()),
                )

    db.commit()
    db.close()

    log_event(task.get("taskId", ""), "review_saved", f"审核任务已保存: {task.get('title', '')}")
    invalidate_cache("stats_")
    invalidate_cache("analytics_")
    invalidate_cache("recent_")


def save_opinion(task_id: str, profile_code: str, profile_name: str, reply: str, phase: str = "", wecom_sent: int = 0, wecom_error: str = "") -> None:
    """保存单条审核意见到 review_opinions 表"""
    conclusion = ""
    for line in reply.splitlines()[:3]:
        line = line.strip()
        if any(sym in line for sym in ["✅", "⚠️", "❌"]):
            conclusion = line[:80]
            break
    quality = assess_reply_quality(reply)
    db = get_db()
    db.execute(
        """INSERT OR REPLACE INTO review_opinions
           (task_id, profile_code, profile_name, reply, conclusion, quality_score, quality_level, quality_flags, wecom_sent, wecom_error, phase, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (task_id, profile_code, profile_name, reply, conclusion,
         quality["score"], quality["level"], json.dumps(quality.get("flags", []), ensure_ascii=False),
         wecom_sent, wecom_error, phase, now()),
    )
    db.commit()
    db.close()


def save_summary_record(task_id: str, summary: str, conclusion: str, must_fix: str = "", conditional_pass: str = "", preconditions: str = "", responsible_dept: str = "") -> None:
    """保存汇总意见到 review_summaries 表"""
    db = get_db()
    db.execute(
        """INSERT OR REPLACE INTO review_summaries
           (task_id, summary, conclusion, must_fix, conditional_pass, preconditions, responsible_dept, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (task_id, summary, conclusion, must_fix, conditional_pass, preconditions, responsible_dept, now(), now()),
    )
    db.commit()
    db.close()


def save_review_file(task_id: str, filename: str, stored_path: str, size: int, file_type: str = "", content_preview: str = "", extracted_fields: dict = None) -> None:
    """保存附件记录到 review_files 表"""
    db = get_db()
    db.execute(
        """INSERT INTO review_files (task_id, filename, stored_path, size, file_type, content_preview, extracted_fields, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (task_id, filename, stored_path, size, file_type, content_preview,
         json.dumps(extracted_fields, ensure_ascii=False) if extracted_fields else "",
         now()),
    )
    db.commit()
    db.close()


def get_task_opinions(task_id: str) -> list:
    """获取某任务的全部审核意见"""
    db = get_db()
    rows = db.execute(
        "SELECT profile_code, profile_name, reply, conclusion, quality_score, quality_level, quality_flags, wecom_sent, phase, created_at FROM review_opinions WHERE task_id=? ORDER BY id",
        (task_id,),
    ).fetchall()
    db.close()
    return [
        {
            "profile": r[0], "name": r[1], "reply": r[2], "conclusion": r[3],
            "qualityScore": r[4], "qualityLevel": r[5],
            "qualityFlags": json.loads(r[6]) if r[6] else [],
            "wecomSent": bool(r[7]), "phase": r[8], "createdAt": r[9],
        }
        for r in rows
    ]


def get_task_summary(task_id: str) -> dict | None:
    """获取某任务的汇总意见"""
    db = get_db()
    row = db.execute(
        "SELECT summary, conclusion, must_fix, conditional_pass, preconditions, responsible_dept, created_at FROM review_summaries WHERE task_id=?",
        (task_id,),
    ).fetchone()
    db.close()
    if not row:
        return None
    return {
        "summary": row[0], "conclusion": row[1], "mustFix": row[2],
        "conditionalPass": row[3], "preconditions": row[4],
        "responsibleDept": row[5], "createdAt": row[6],
    }


def update_review_status(task_id: str, status: str, conclusion: str = "", phase: str = "", failed_reason: str = ""):
    """更新审核任务状态"""
    status = normalize_status(status)
    db = get_db()
    finished_at = now() if status in {"completed", "failed", "cancelled", "partial"} else ""
    db.execute(
        "UPDATE reviews SET status=?, conclusion=CASE WHEN ?!='' THEN ? ELSE conclusion END, current_phase=CASE WHEN ?!='' THEN ? ELSE current_phase END, failed_reason=CASE WHEN ?!='' THEN ? ELSE failed_reason END, finished_at=CASE WHEN ?!='' THEN ? ELSE finished_at END, updated_at=? WHERE task_id=?",
        (status, conclusion, conclusion, phase, phase, failed_reason, failed_reason, finished_at, finished_at, now(), task_id),
    )
    db.commit()
    db.close()
    log_event(task_id, "status_changed", f"状态变更为: {status}")
    invalidate_cache("stats_")
    invalidate_cache("analytics_")
    invalidate_cache("recent_")


def get_history(limit: int = 20, offset: int = 0, mode: str = "", status: str = "", q: str = "") -> dict:
    """分页获取审核历史"""
    db = get_db()
    conditions = []
    params = []

    if mode:
        conditions.append("mode=?")
        params.append(mode)
    if status:
        conditions.append("status=?")
        params.append(status)

    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    # 总数
    total_row = db.execute(f"SELECT COUNT(*) FROM reviews {where}", params).fetchone()
    total = total_row[0] if total_row else 0

    # 数据
    rows = db.execute(
        f"SELECT task_id,mode,title,mode_label,status,sent_count,error_count,reviewer_count,completed_count,summary,conclusion,created_at,updated_at,current_phase,progress_json,source FROM reviews {where} ORDER BY id DESC LIMIT ? OFFSET ?",
        params + [limit, offset],
    ).fetchall()

    history = [
        {
            "taskId": r[0], "mode": r[1], "title": r[2], "modeLabel": r[3],
            "status": normalize_status(r[4]), "sentCount": r[5], "errorCount": r[6],
            "reviewerCount": r[7], "completedCount": r[8],
            "summary": r[9], "conclusion": r[10], "createdAt": r[11], "updatedAt": r[12],
            "currentPhase": r[13], "progress": safe_json_loads(r[14], {}), "source": r[15],
        }
        for r in rows
    ]

    db.close()

    # 文本搜索过滤
    if q:
        q_lower = q.lower()
        history = [h for h in history if q_lower in h.get("title", "").lower() or q_lower in h.get("modeLabel", "").lower()]

    return {"history": history, "total": total, "limit": limit, "offset": offset}


def get_review(task_id: str) -> dict | None:
    """获取单条审核详情"""
    db = get_db()
    row = db.execute(
        "SELECT task_id,mode,title,message,mode_label,status,sent_count,error_count,reviewer_count,completed_count,results_json,summary,conclusion,created_at,updated_at,current_phase,progress_json,source,started_at,finished_at,failed_reason FROM reviews WHERE task_id=?",
        (task_id,),
    ).fetchone()
    if not row:
        db.close()
        return None
    result = {
        "taskId": row[0], "mode": row[1], "title": row[2], "message": row[3],
        "modeLabel": row[4], "status": normalize_status(row[5]), "sentCount": row[6], "errorCount": row[7],
        "reviewerCount": row[8], "completedCount": row[9],
        "results": safe_json_loads(row[10], {}),
        "summary": row[11], "conclusion": row[12],
        "createdAt": row[13], "updatedAt": row[14],
        "currentPhase": row[15], "progress": safe_json_loads(row[16], {}), "source": row[17],
        "startedAt": row[18], "finishedAt": row[19], "failedReason": row[20],
    }
    db.close()
    return result


def get_audit_log(task_id: str, limit: int = 50) -> list:
    """获取审核任务的事件日志"""
    db = get_db()
    rows = db.execute(
        "SELECT event_type, description, profile_code, metadata, created_at FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT ?",
        (task_id, limit),
    ).fetchall()
    result = [
        {"eventType": r[0], "description": r[1], "profileCode": r[2],
         "metadata": json.loads(r[3]) if r[3] else {}, "createdAt": r[4]}
        for r in rows
    ]
    db.close()
    return result


def delete_review(task_id: str) -> bool:
    """删除审核任务及其关联数据"""
    db = get_db()
    db.execute("DELETE FROM reviews WHERE task_id=?", (task_id,))
    db.execute("DELETE FROM attachments WHERE task_id=?", (task_id,))
    db.execute("DELETE FROM task_events WHERE task_id=?", (task_id,))
    db.commit()
    db.close()
    # 删除任务文件
    task_file = TASK_DIR / f"{task_id}.json"
    if task_file.exists():
        task_file.unlink()
    progress_file = PROGRESS_DIR / f"{task_id}.json"
    if progress_file.exists():
        progress_file.unlink()
    log_event(task_id, "deleted", "审核任务已删除")
    invalidate_cache()
    return True


def _stats_impl() -> dict:
    """获取审核统计（内部实现）"""
    db = get_db()
    total = db.execute("SELECT COUNT(*) FROM reviews").fetchone()[0]
    internal = db.execute("SELECT COUNT(*) FROM reviews WHERE mode='internal'").fetchone()[0]
    market = db.execute("SELECT COUNT(*) FROM reviews WHERE mode='market'").fetchone()[0]
    today = db.execute("SELECT COUNT(*) FROM reviews WHERE created_at >= date('now','localtime')").fetchone()[0]
    pending = db.execute("SELECT COUNT(*) FROM reviews WHERE status='pending'").fetchone()[0]
    completed = db.execute("SELECT COUNT(*) FROM reviews WHERE status='completed'").fetchone()[0]
    failed = db.execute("SELECT COUNT(*) FROM reviews WHERE status='failed'").fetchone()[0]
    result = {
        "total": total, "internal": internal, "market": market, "today": today,
        "pending": pending, "completed": completed, "failed": failed,
    }
    db.close()
    return result

def stats() -> dict:
    """获取审核统计（5秒TTL缓存）"""
    return cached("stats_dashboard", 5, _stats_impl)

def _fetch_recent_tasks() -> list:
    """获取最近任务（内部实现）"""
    db = get_db()
    rows = db.execute("SELECT task_id, title, status, created_at FROM reviews ORDER BY id DESC LIMIT 5").fetchall()
    recent = [{"taskId": r[0], "title": r[1], "status": r[2], "createdAt": r[3]} for r in rows]
    db.close()
    return recent


def _analytics_impl() -> dict:
    """获取多维度审核分析数据（内部实现）"""
    db = get_db()

    # 按天统计审核量（最近30天）
    daily = db.execute("""
        SELECT date(created_at) as d, COUNT(*) as cnt
        FROM reviews WHERE created_at >= date('now','localtime','-30 days')
        GROUP BY d ORDER BY d
    """).fetchall()
    daily_counts = [{"date": r[0], "count": r[1]} for r in daily]

    # 按模式统计
    by_mode = db.execute("""
        SELECT mode, COUNT(*) FROM reviews
        WHERE mode != '' GROUP BY mode
    """).fetchall()
    mode_counts = {r[0]: r[1] for r in by_mode}

    total_with_conclusion = db.execute(
        "SELECT COUNT(*) FROM reviews WHERE conclusion != ''"
    ).fetchone()[0]
    pass_count = db.execute(
        "SELECT COUNT(*) FROM reviews WHERE conclusion LIKE '%通过%' AND conclusion NOT LIKE '%不通过%'"
    ).fetchone()[0]
    reject_count = db.execute(
        "SELECT COUNT(*) FROM reviews WHERE conclusion LIKE '%驳回%' OR conclusion LIKE '%不通过%'"
    ).fetchone()[0]

    week_total = db.execute(
        "SELECT COUNT(*) FROM reviews WHERE created_at >= date('now','localtime','weekday 0','-6 days')"
    ).fetchone()[0]
    week_completed = db.execute(
        "SELECT COUNT(*) FROM reviews WHERE status='completed' AND created_at >= date('now','localtime','weekday 0','-6 days')"
    ).fetchone()[0]

    avg_sent = db.execute("SELECT AVG(sent_count) FROM reviews WHERE sent_count > 0").fetchone()[0] or 0

    status_dist = db.execute("""
        SELECT status, COUNT(*) FROM reviews
        WHERE status != '' GROUP BY status
    """).fetchall()
    status_counts = {r[0]: r[1] for r in status_dist}

    # 按 profile 统计近7天审核参与次数
    profile_activity = db.execute("""
        SELECT profile_code, profile_name, COUNT(*) as cnt
        FROM review_opinions
        WHERE created_at >= date('now','localtime','-7 days')
        GROUP BY profile_code
        ORDER BY cnt DESC
    """).fetchall()

    analytics = {
        "ok": True,
        "dailyCounts": daily_counts,
        "modeCounts": mode_counts,
        "statusCounts": status_counts,
        "passRate": {
            "total": total_with_conclusion,
            "pass": pass_count,
            "reject": reject_count,
            "rate": round(pass_count / max(total_with_conclusion, 1) * 100),
        },
        "weekly": {"total": week_total, "completed": week_completed},
        "avgSentCount": round(avg_sent, 1),
        "profileActivity": [
            {"profile": r[0], "name": r[1], "count": r[2]}
            for r in profile_activity
        ],
    }
    db.close()
    return analytics

def get_analytics() -> dict:
    """获取多维度审核分析（30秒TTL缓存）"""
    return cached("analytics_dashboard", 30, _analytics_impl)


# ============================================================================
# 辅助函数
# ============================================================================

def read_body(handler: SimpleHTTPRequestHandler) -> dict:
    n = int(handler.headers.get("Content-Length") or 0)
    raw = handler.rfile.read(n) if n else b"{}"
    try:
        return json.loads(raw.decode("utf-8") or "{}")
    except Exception:
        return {}


def classify_mode(text: str, explicit: str = "") -> str:
    if explicit in {"market", "internal"}:
        return explicit
    internal_keywords = ("内部", "运营", "制度", "整改", "专项", "外包", "费用调整", "管理办法", "工作方案", "内部方案")
    market_keywords = ("招标", "投标", "报价", "选聘", "市场拓展", "测算", "招标文件", "物业选聘")
    if any(k in text for k in internal_keywords):
        return "internal"
    if any(k in text for k in market_keywords):
        return "market"
    return "unknown"


def profile_by_code(code: str) -> dict | None:
    for p in PROFILES_8:
        if p["profile"] == code:
            return p
    return None


# ============================================================================
# 文件内容提取
# ============================================================================

def extract_file_content(filepath: str) -> str:
    path = Path(filepath)
    ext = path.suffix.lower()
    try:
        if ext == '.txt':
            return path.read_text(errors='ignore')[:8000]
        elif ext == '.docx':
            import docx
            doc = docx.Document(str(path))
            return '\n'.join(p.text for p in doc.paragraphs if p.text.strip())[:8000]
        elif ext == '.pdf':
            from PyPDF2 import PdfReader
            reader = PdfReader(str(path))
            parts = []
            for page in reader.pages:
                t = page.extract_text()
                if t:
                    parts.append(t)
            return '\n'.join(parts)[:8000]
        elif ext in ('.xlsx',):
            import openpyxl
            wb = openpyxl.load_workbook(str(path), data_only=True)
            merged_map = {}
            for sheet_name in wb.sheetnames:
                ws = wb[sheet_name]
                for rng in ws.merged_cells.ranges:
                    val = ws.cell(rng.min_row, rng.min_col).value
                    for row in range(rng.min_row, rng.max_row + 1):
                        for col in range(rng.min_col, rng.max_col + 1):
                            merged_map[(sheet_name, row, col)] = val
            rows = []
            for sheet_name in wb.sheetnames:
                ws = wb[sheet_name]
                sheet_rows = []
                for r_idx, row in enumerate(ws.iter_rows(min_row=1, values_only=False), 1):
                    cells = []
                    for cell in row:
                        v = cell.value
                        if v is None:
                            v = merged_map.get((sheet_name, cell.row, cell.column), '')
                        cells.append(str(v) if v is not None and v != '' else '')
                    if any(c.strip() for c in cells):
                        sheet_rows.append(' | '.join(cells))
                if sheet_rows:
                    rows.append(f"\n=== {sheet_name} ===")
                    rows.extend(sheet_rows)
            return '\n'.join(rows)[:50000]
        elif ext in ('.xls',):
            import xlrd
            wb = xlrd.open_workbook(str(path), formatting_info=False)
            rows = []
            for sheet_name in wb.sheet_names():
                ws = wb.sheet_by_name(sheet_name)
                sheet_rows = []
                for r in range(ws.nrows):
                    cells = [str(ws.cell_value(r, c)) if ws.cell_value(r, c) != '' else '' for c in range(ws.ncols)]
                    if any(c.strip() for c in cells):
                        sheet_rows.append(' | '.join(cells))
                if sheet_rows:
                    rows.append(f"\n=== {sheet_name} ===")
                    rows.extend(sheet_rows)
            return '\n'.join(rows)[:50000]
        elif ext in ('.doc',):
            return "[旧版 .doc 格式，建议转换为 .docx 后重新上传]"
        elif ext in ('.png', '.jpg', '.jpeg', '.gif', '.bmp'):
            return f"[图片文件: {path.name}，文本无法提取，请人工查看]"
        else:
            return f"[不支持的文件格式: {ext}]"
    except Exception as e:
        return f"[文件内容提取失败: {e}]"


# ============================================================================
# Hermes 调用
# ============================================================================

def _call_deepseek_api_sync(prompt: str, role: str = "审核机器人", knowledge_text: str = "") -> tuple[str, str]:
    """通过 DeepSeek API 同步调用（非流式），返回 (reply, error)"""
    import urllib.request
    import urllib.error

    if not DEEPSEEK_API_KEY:
        return "", "DeepSeek API 密钥未配置，请通过受保护的环境文件提供"

    knowledge_block = f"\n\n【参考知识】\n{knowledge_text}\n" if knowledge_text.strip() else ""
    system_prompt = f"你是第一服务{role}专业审核专家。依据第一服务作业标准和行业惯例，对提交材料进行深度数据分析。引用具体数字、计算比例、识别风险，像资深专业经理一样用数据说话。最后给出明确结论（✅通过/⚠️条件通过/❌不通过）。{knowledge_block}"
    payload = json.dumps({
        "model": DEEPSEEK_MODEL,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt},
        ],
        "stream": False,
        "temperature": 0.3,
        "max_tokens": 4096,
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{DEEPSEEK_BASE_URL}/chat/completions",
        data=payload,
        headers={
            "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            choices = data.get("choices", [])
            if choices:
                content = choices[0].get("message", {}).get("content", "")
                return content.strip(), ""
            return "", "DeepSeek API 返回空内容"
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace")[:300]
        return "", f"DeepSeek API 错误 ({e.code})：{error_body}"
    except Exception as e:
        return "", f"DeepSeek API 调用失败：{e}"


def clean_hermes_output(out: str) -> str:
    text = out or ""
    text = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", text)
    box_matches = re.findall(r"⚕ Hermes.*?\n(.*?)\n╰", text, flags=re.S)
    if box_matches:
        text = box_matches[-1]
    text = re.sub(r"╭.*?╮", "", text, flags=re.S)
    text = re.sub(r"╰.*", "", text, flags=re.S)
    text = re.sub(r"[╭╮╰╯─┊]+", "", text)
    lines = []
    skip_prefixes = ("Hermes", "Model:", "Provider:", "Session:", "Tools:", "Working directory:", "Query:", "Initializing agent", "Resume this session", "Duration:", "Messages:", "session_id:", "💻", "⚙")
    for line in text.splitlines():
        l = line.strip()
        if not l:
            continue
        if l.startswith(skip_prefixes):
            continue
        if any(x in l for x in ["preparing terminal", "wecom_latest_file.py", "tool calls"]):
            continue
        if "thinking" in l.lower() and len(l) < 80:
            continue
        lines.append(l)
    text = "\n".join(lines).strip()
    if len(text) > 1200:
        text = text[-1200:].strip()
    return text or "未获取到可见回复。"


def call_profile(profile: str, role: str, message: str, mode: str, rule: str, file_contents: str = "") -> tuple[str, str]:
    scope = "市场拓展/投标审核" if mode == "market" else "内部方案审核" if mode == "internal" else "专业单聊"
    file_block = ""
    if file_contents.strip():
        file_block = f"""
【附加上传文件内容】
{file_contents[:40000]}
---
"""
    prompt = f"""你是第一服务{role}专业审核专家。

审核场景：{scope}
专业边界：{rule}

审核要求：
1. 深入分析上传文件中的具体数据，引用实际数字（金额、比例、人数等）进行计算验证。
2. 从本专业角度识别具体风险点，说明为什么是风险、影响多大。
3. 对比第一服务作业标准和行业惯例，指出偏差。
4. 给出明确结论（✅通过/⚠️条件通过/❌不通过）并说明依据。
5. 如有条件通过或不通过，给出具体整改建议。
6. 只讲本专业判断，不代替其他专业发言。

分析风格：像资深专业经理审阅方案一样，用数据说话，不说空话套话。

【审核材料】
{message}
{file_block}"""

    # 服务器上无 Hermes agent → 使用 DeepSeek API 直连
    if not HERMES_PY.exists():
        knowledge_text = rag_store.retrieve(profile, message)
        return _call_deepseek_api_sync(prompt, role, knowledge_text)

    # 本地 Mac 上有 Hermes agent → 使用 subprocess 调用
    cmd = [str(HERMES_PY), "-m", "hermes_cli.main", "--profile", profile, "chat", "-Q", "-q", prompt, "--source", "review-ui"]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=180, cwd=str(AGENT_ROOT))
        raw = (p.stdout or "") + ("\n" + p.stderr if p.stderr else "")
        if p.returncode != 0:
            return clean_hermes_output(raw), f"profile returned {p.returncode}"
        return clean_hermes_output(raw), ""
    except subprocess.TimeoutExpired as e:
        raw = ((e.stdout or "") if isinstance(e.stdout, str) else "") + ((e.stderr or "") if isinstance(e.stderr, str) else "")
        return clean_hermes_output(raw) if raw else "调用超时，未取得完整回复。", "timeout"
    except Exception as e:
        return f"调用失败：{e}", str(e)


def call_raw_profile(prompt: str) -> tuple[str, str]:
    # 服务器上无 Hermes agent → 使用 DeepSeek API 直连
    if not HERMES_PY.exists():
        return _call_deepseek_api_sync(prompt, "汇总官")

    # 本地 Mac 上有 Hermes agent → 使用 subprocess 调用
    cmd = [str(HERMES_PY), "-m", "hermes_cli.main", "chat", "-Q", "-q", prompt, "--source", "review-ui-summary"]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=120, cwd=str(AGENT_ROOT))
        raw = (p.stdout or "") + ("\n" + p.stderr if p.stderr else "")
        return clean_hermes_output(raw), ""
    except subprocess.TimeoutExpired as e:
        raw = ((e.stdout or "") if isinstance(e.stdout, str) else "") + ((e.stderr or "") if isinstance(e.stderr, str) else "")
        return clean_hermes_output(raw) if raw else "调用超时", "timeout"
    except Exception as e:
        return f"调用失败：{e}", str(e)


# ============================================================================
# 企微发送
# ============================================================================

def send_wecom_message(message: str, target: str = WECOM_GROUP_TARGET, retries: int = 2) -> dict:
    """发送企微消息，支持自动重试"""
    profile_home = f"/Users/zhangye/.hermes/profiles/{SEND_PROFILE}"
    env = os.environ.copy()
    env["HERMES_HOME"] = profile_home
    env_path = Path(profile_home) / ".env"
    if env_path.exists():
        for line in env_path.read_text(errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k and k not in env:
                env[k] = v
    env["PYTHONPATH"] = str(AGENT_ROOT) + (":" + env.get("PYTHONPATH", "")) if env.get("PYTHONPATH") else str(AGENT_ROOT)

    code = (
        "import sys, json\n"
        "from tools.send_message_tool import send_message_tool\n"
        "msg = open(sys.argv[1]).read()\n"
        "target = sys.argv[2]\n"
        "result = send_message_tool({'action': 'send', 'target': target, 'message': msg})\n"
        "print(json.dumps(result))\n"
    )
    tmp = Path(f"/tmp/wecom_ui_send_{SEND_PROFILE}.txt")
    tmp.write_text(message)

    last_error = ""
    for attempt in range(retries + 1):
        try:
            p = subprocess.run(
                [str(HERMES_PY), "-c", code, str(tmp), target],
                capture_output=True, text=True, timeout=90,
                cwd=str(AGENT_ROOT), env=env,
            )
            out = (p.stdout or "") + (p.stderr or "")
            if p.returncode != 0:
                last_error = out[-2000:]
                if attempt < retries:
                    time.sleep(1.5)
                    continue
                return {"ok": False, "error": last_error}
            try:
                clean = out.strip()
                result = json.loads(clean)
                if isinstance(result, str):
                    result = json.loads(result)
                if not result.get("success"):
                    last_error = f"send success=false: {clean[-500:]}"
                    if attempt < retries:
                        time.sleep(1.5)
                        continue
                    return {"ok": False, "error": last_error}
            except Exception:
                if '"success": true' not in out.replace('\\"', '"') and "'success': True" not in out:
                    last_error = out[-500:]
                    if attempt < retries:
                        time.sleep(1.5)
                        continue
                    return {"ok": False, "error": last_error}
            return {"ok": True, "output": out}
        except subprocess.TimeoutExpired:
            last_error = "企微发送超时"
            if attempt < retries:
                time.sleep(1.5)
                continue
            return {"ok": False, "error": last_error}
        except Exception as e:
            last_error = str(e)
            if attempt < retries:
                time.sleep(1.5)
                continue
            return {"ok": False, "error": last_error}

    return {"ok": False, "error": last_error}


# ============================================================================
# 审核意见质量评估
# ============================================================================

QUALITY_THRESHOLD = 60  # 低于此分为不合格


def assess_reply_quality(reply: str) -> dict:
    """评估单条审核意见质量，返回分数(0-100)和标记"""
    if not reply or reply == "未获取到可见回复。" or len(reply.strip()) < 10:
        return {"score": 0, "level": "不合格", "flags": ["内容为空"], "suggestion": "机器人未返回有效回复，需重新调用", "pass": False}

    score = 100
    flags = []

    # 1. 是否有明确结论（✅/⚠️/❌）
    if any(sym in reply[:100] for sym in ["✅", "⚠️", "❌"]):
        score -= 0
    else:
        score -= 25
        flags.append("缺少明确结论标记(✅/⚠️/❌)")

    # 2. 内容充分度：字数
    reply_len = len(reply)
    if reply_len < 80:
        score -= 30
        flags.append(f"回复过短({reply_len}字)，缺乏详细分析")
    elif reply_len < 150:
        score -= 15
        flags.append(f"回复较短({reply_len}字)，建议补充细节")

    # 3. 是否包含具体依据
    has_evidence = False
    evidence_keywords = ["依据", "根据", "按照", "参考", "标准", "规范", "要求", "规定", "因为", "由于", "建议", "注意", "风险"]
    for kw in evidence_keywords:
        if kw in reply:
            has_evidence = True
            break
    if not has_evidence:
        score -= 20
        flags.append("缺少具体依据或引用标准")

    # 4. 是否有补充资料需求
    has_supplement = any(kw in reply for kw in ["补充", "提供", "缺失", "不明确", "需要进一步", "待确认", "资料不足"])
    if not has_supplement and score < 70:
        score -= 5
        flags.append("未指出需补充的资料")

    # 5. 是否涉及其他专业（越界检查）
    other_profile_keywords = ["TF", "SS", "KF", "SQ", "WS", "CW", "XX", "RL", "其他专业", "应由", "@"]
    cross_count = sum(1 for kw in other_profile_keywords if kw in reply)
    if cross_count >= 3:
        score -= 15
        flags.append("涉及多个其他专业判断（可能越界）")

    score = max(0, min(100, score))

    level = "优秀" if score >= 85 else "良好" if score >= 70 else "合格" if score >= QUALITY_THRESHOLD else "不合格"

    suggestion = ""
    if score < QUALITY_THRESHOLD:
        suggestion = "建议重新审核："
        if "内容为空" in "\n".join(flags):
            suggestion += "机器人返回无效，需重新调用"
        elif "缺少明确结论" in "\n".join(flags):
            suggestion += "请要求机器人明确输出✅/⚠️/❌结论"
        elif "回复过短" in "\n".join(flags):
            suggestion += "请要求机器人输出更详细的专业分析"
        elif "缺少具体依据" in "\n".join(flags):
            suggestion += "请要求机器人引用具体标准或规范"
        elif "越界" in "\n".join(flags):
            suggestion += "请重新调用并强调只审本专业范围"
        else:
            suggestion += "回复质量不足，建议重试"

    return {
        "score": score,
        "level": level,
        "flags": flags,
        "suggestion": suggestion,
        "pass": score >= QUALITY_THRESHOLD,
    }


def assess_task_quality(task_id: str) -> dict:
    """评估整个任务所有审核意见的质量"""
    review = get_review(task_id)
    if not review:
        return {"ok": False, "error": "task not found"}

    results = review.get("results", {})
    assessments = []
    if isinstance(results, list):
        for r in results:
            p = r.get("profile", {})
            quality = assess_reply_quality(r.get("reply", ""))
            assessments.append({
                "profile": p.get("profile"),
                "name": p.get("name"),
                "quality": quality,
            })
    elif isinstance(results, dict) and results.get("reply"):
        p = results.get("profile", {})
        quality = assess_reply_quality(results.get("reply", ""))
        assessments.append({
            "profile": p.get("profile"),
            "name": p.get("name"),
            "quality": quality,
        })

    pass_count = sum(1 for a in assessments if a["quality"]["pass"])
    fail_profiles = [a for a in assessments if not a["quality"]["pass"]]

    return {
        "ok": True,
        "taskId": task_id,
        "assessments": assessments,
        "summary": {
            "total": len(assessments),
            "pass": pass_count,
            "fail": len(assessments) - pass_count,
            "failProfiles": fail_profiles,
            "qualityRate": round(pass_count / max(len(assessments), 1) * 100),
        },
    }


def re_review_profile(task_id: str, profile_code: str) -> dict:
    """重新调用某个专业审核（质量不合格时使用）"""
    review = get_review(task_id)
    if not review:
        return {"ok": False, "error": "task not found"}

    target = profile_by_code(profile_code)
    if not target:
        return {"ok": False, "error": f"unknown profile: {profile_code}"}

    mode = review.get("mode", "internal")
    message = review.get("message", "")

    if mode == "market":
        tf_result = review.get("results")
        tf_reply = ""
        if isinstance(tf_result, list) and len(tf_result) > 0:
            tf_reply = tf_result[0].get("reply", "")
        rule = f"市场拓展七专业重新审核（上次评分不合格）。必须基于TF测算结果输出✅/⚠️/❌明确结论。{target['name']}只审本专业范围。"
        context_msg = f"【TF先行测算结果】\n{tf_reply}\n---\n【原始审核材料】\n{message}" if tf_reply else message
    elif mode == "internal":
        context_msg = message
        rule = f"内部方案重新审核（上次评分不合格）。必须输出✅/⚠️/❌明确结论，{target['name']}只审本专业范围。"
    else:
        context_msg = message
        rule = "重新输出审核意见，必须明确结论。"

    log_event(task_id, "re_review_started", f"重新审核：{target['name']}", profile_code=profile_code)

    reply, call_error = call_profile(
        target["profile"], target["role"], context_msg, mode, rule,
    )

    quality = assess_reply_quality(reply)

    log_event(task_id, "re_review_completed" if not call_error else "re_review_failed",
              f"重新审核{'完成' if not call_error else '失败'}: {target['name']} 质量: {quality['level']}({quality['score']}分)",
              profile_code=profile_code,
              metadata={"quality": quality})

    # 持久化重审结果到数据库
    if not call_error:
        existing = review.get("results", [])
        if isinstance(existing, dict):
            existing = existing.get(profile_code, [existing])
        if isinstance(existing, list):
            updated = False
            for r in existing:
                if isinstance(r, dict) and r.get("profile") == profile_code:
                    r["reply"] = reply
                    r["quality"] = quality
                    updated = True
                    break
            if not updated:
                existing.append({"profile": profile_code, "name": target["name"], "reply": reply, "quality": quality})
            db = get_db()
            db.execute(
                "UPDATE reviews SET results_json=?, updated_at=? WHERE task_id=?",
                (json.dumps(existing, ensure_ascii=False), now(), task_id),
            )
            db.commit()
            db.close()
            log_event(task_id, "re_review_persisted", f"重审结果已写入数据库: {target['name']}", profile_code=profile_code)
            invalidate_cache()

    return {
        "ok": not bool(call_error),
        "taskId": task_id,
        "profile": target,
        "reply": reply,
        "quality": quality,
        "callError": call_error,
    }


# ============================================================================
# 汇总生成
# ============================================================================

SUMMARY_PROMPT = """你是第一服务研发小组的八专业汇总官。

以下是8个专业对同一方案的审核意见。请归纳：

1. 【必须修改项】列出各专业一致认为必须修改的内容
2. 【条件通过项】列出需要补充资料/满足前置条件才能通过的内容
3. 【执行前置条件】在方案执行前必须完成的事项清单
4. 【最终建议】一句话总结：建议通过/条件通过/建议驳回 + 理由

输出格式（纯文字，500字以内）：

❗必须修改：
- ...
⚠️条件通过：
- ...
📋执行前置：
- ...
✅最终建议：...

以下是八专业意见：

{REPLIES}
"""


def make_summary(task_id: str) -> dict:
    review = get_review(task_id)
    if not review:
        return {"ok": False, "error": "task not found"}

    results = review.get("results")
    # 回退：如果 results 为空，从 review_opinions 表重建
    if not results or results == {} or results == []:
        opinions = get_task_opinions(task_id)
        if opinions:
            results = [{"profile": {"name": o.get("profileName", "?"), "profile": o.get("profileCode", "")}, "reply": o.get("reply", "")} for o in opinions]
        else:
            return {"ok": False, "error": "no results to summarize"}

    replies_parts = []
    if isinstance(results, list):
        for r in results:
            p = r.get("profile", {})
            replies_parts.append(f"【{p.get('name', '?')}】\n{r.get('reply', '无')}\n")
    elif isinstance(results, dict) and "reply" in results:
        p = results.get("profile", {})
        replies_parts.append(f"【{p.get('name', '?')}】\n{results.get('reply', '无')}\n")

    prompt = SUMMARY_PROMPT.replace("{REPLIES}", "\n".join(replies_parts))
    summary, err = call_raw_profile(prompt)

    # 提取最终建议作为 conclusion
    conclusion = ""
    for line in summary.splitlines():
        line = line.strip()
        if "最终建议" in line or "✅" in line:
            conclusion = line
            break

    db = get_db()
    db.execute("UPDATE reviews SET summary=?, conclusion=?, updated_at=? WHERE task_id=?", (summary, conclusion, now(), task_id))
    db.commit()
    db.close()

    # 解析结构化汇总字段
    must_fix = ""
    conditional_pass = ""
    preconditions = ""
    for line in summary.splitlines():
        line = line.strip()
        if "必须修改" in line or "❗" in line:
            must_fix += line + "\n"
        elif "条件通过" in line or "⚠️" in line:
            conditional_pass += line + "\n"
        elif "执行前置" in line or "📋" in line:
            preconditions += line + "\n"
    save_summary_record(task_id, summary, conclusion, must_fix.strip(), conditional_pass.strip(), preconditions.strip())

    log_event(task_id, "summary_generated", "八专业汇总意见已生成")
    invalidate_cache("analytics_")
    invalidate_cache("recent_")

    return {"ok": True, "taskId": task_id, "summary": summary, "conclusion": conclusion, "error": err}


def generate_markdown_report(task_id: str) -> str:
    review = get_review(task_id)
    if not review:
        return "ERROR: task not found"

    lines = [
        f"# {review.get('title', '审核报告')}",
        "",
        f"**任务ID**: `{task_id}`",
        f"**类型**: {review.get('modeLabel', '未知')} | **状态**: {review.get('status', '未知')}",
        f"**时间**: {review.get('createdAt', '未知')} | **更新**: {review.get('updatedAt', '未知')}",
        f"**审核进度**: {review.get('completedCount', 0)}/{review.get('reviewerCount', 0)}",
        f"**发送条数**: {review.get('sentCount', 0)} | **错误**: {review.get('errorCount', 0)}",
        "",
    ]
    if review.get("message"):
        lines += ["## 审核问题", "", review["message"], ""]

    results = review.get("results")
    if results:
        lines.append("## 各专业审核意见")
        lines.append("")
        if isinstance(results, list):
            for r in results:
                p = r.get("profile", {})
                name = p.get("name", "未知专业")
                reply = r.get("reply", "无回复")
                conclusion_text = ""
                if "✅" in reply[:20] or "⚠️" in reply[:20] or "❌" in reply[:20]:
                    for ch in reply[:30]:
                        conclusion_text += ch
                        if "\n" == ch:
                            break
                lines.append(f"### {name}")
                lines.append(f"**结论**: {conclusion_text.strip()}")
                lines.append("")
                lines.append(reply)
                lines.append("")
        elif isinstance(results, dict) and results.get("reply"):
            p = results.get("profile", {})
            lines.append(f"### {p.get('name', 'TF')}")
            lines.append("")
            lines.append(results["reply"])
            lines.append("")

    if review.get("summary"):
        lines += ["---", "", "## 八专业汇总意见", "", review["summary"], ""]
    if review.get("conclusion"):
        lines += ["", f"**最终结论**: {review['conclusion']}", ""]

    # 审计日志
    audit = get_audit_log(task_id, limit=20)
    if audit:
        lines += ["---", "", "## 操作日志", ""]
        for entry in audit:
            lines.append(f"- {entry['createdAt']} | {entry['eventType']} | {entry['description']}")
        lines.append("")

    lines += [
        "---",
        "",
        f"*由第一服务研发小组审核系统 v1.1 自动生成 · {now()}*",
        "",
    ]
    return "\n".join(lines)


# ============================================================================
# Excel 导出
# ============================================================================

def generate_excel_report(task_id: str) -> bytes | None:
    """生成审核报告 Excel 文件，返回 bytes"""
    review = get_review(task_id)
    if not review:
        return None

    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
    except ImportError:
        return None  # openpyxl 未安装

    wb = Workbook()

    # ── 样式 ──
    header_font = Font(name="微软雅黑", bold=True, size=12, color="FFFFFF")
    header_fill = PatternFill(start_color="1D4B79", end_color="1D4B79", fill_type="solid")
    title_font = Font(name="微软雅黑", bold=True, size=14)
    normal_font = Font(name="微软雅黑", size=10)
    pass_fill = PatternFill(start_color="E8F5E9", end_color="E8F5E9", fill_type="solid")
    fail_fill = PatternFill(start_color="FFEBEE", end_color="FFEBEE", fill_type="solid")
    thin_border = Border(
        left=Side(style="thin"), right=Side(style="thin"),
        top=Side(style="thin"), bottom=Side(style="thin"),
    )

    def style_header(ws, cols, row=1):
        for c in range(1, cols + 1):
            cell = ws.cell(row=row, column=c)
            cell.font = header_font
            cell.fill = header_fill
            cell.alignment = Alignment(horizontal="center", vertical="center")
            cell.border = thin_border

    def style_data(ws, start_row, end_row, cols):
        for r in range(start_row, end_row + 1):
            for c in range(1, cols + 1):
                cell = ws.cell(row=r, column=c)
                cell.font = normal_font
                cell.border = thin_border
                cell.alignment = Alignment(wrap_text=True, vertical="top")

    # ── Sheet 1: 审核概要 ──
    ws1 = wb.active
    ws1.title = "审核概要"
    ws1.merge_cells("A1:D1")
    ws1.cell(row=1, column=1, value=review.get("title", "审核报告")).font = title_font

    info = [
        ("任务ID", review.get("taskId", "")),
        ("审核类型", review.get("modeLabel", "")),
        ("状态", review.get("status", "")),
        ("审核问题", review.get("message", "")),
        ("创建时间", review.get("createdAt", "")),
        ("更新时间", review.get("updatedAt", "")),
        ("审核进度", f"{review.get('completedCount', 0)}/{review.get('reviewerCount', 0)}"),
        ("发送条数", str(review.get("sentCount", 0))),
        ("错误数", str(review.get("errorCount", 0))),
        ("最终结论", review.get("conclusion", "")),
    ]
    for i, (label, value) in enumerate(info, start=3):
        ws1.cell(row=i, column=1, value=label).font = Font(name="微软雅黑", bold=True, size=10)
        ws1.cell(row=i, column=2, value=value).font = normal_font
        ws1.merge_cells(start_row=i, start_column=2, end_row=i, end_column=4)

    ws1.column_dimensions["A"].width = 14
    ws1.column_dimensions["B"].width = 25
    ws1.column_dimensions["C"].width = 40
    ws1.column_dimensions["D"].width = 20

    # ── Sheet 2: 各专业审核意见 ──
    ws2 = wb.create_sheet("各专业审核意见")
    headers2 = ["序号", "专业", "代号", "结论", "审核意见", "企微发送", "质量评分"]
    for c, h in enumerate(headers2, 1):
        ws2.cell(row=1, column=c, value=h)
    style_header(ws2, len(headers2))

    results = review.get("results", {})
    if isinstance(results, list):
        for i, r in enumerate(results):
            row = i + 2
            p = r.get("profile", {})
            reply = r.get("reply", "")
            wecom_ok = r.get("wecomResult", {}).get("ok", False) if isinstance(r.get("wecomResult"), dict) else False
            quality = assess_reply_quality(reply)
            conclusion_sym = ""
            for sym in ["✅", "⚠️", "❌"]:
                if sym in reply[:50]:
                    conclusion_sym = sym
                    break
            ws2.cell(row=row, column=1, value=i + 1)
            ws2.cell(row=row, column=2, value=p.get("name", ""))
            ws2.cell(row=row, column=3, value=p.get("profile", ""))
            ws2.cell(row=row, column=4, value=conclusion_sym)
            ws2.cell(row=row, column=5, value=reply)
            ws2.cell(row=row, column=6, value="✅已发送" if wecom_ok else "⚠️未发送")
            ws2.cell(row=row, column=7, value=f"{quality.get('level', '')}({quality.get('score', 0)}分)")
            # 着色
            if quality.get("score", 0) >= 85:
                for c in range(1, 8):
                    ws2.cell(row=row, column=c).fill = pass_fill
            elif quality.get("score", 0) < 60:
                for c in range(1, 8):
                    ws2.cell(row=row, column=c).fill = fail_fill
        style_data(ws2, 2, len(results) + 1, len(headers2))

    ws2.column_dimensions["A"].width = 6
    ws2.column_dimensions["B"].width = 14
    ws2.column_dimensions["C"].width = 14
    ws2.column_dimensions["D"].width = 8
    ws2.column_dimensions["E"].width = 60
    ws2.column_dimensions["F"].width = 12
    ws2.column_dimensions["G"].width = 16

    # ── Sheet 3: 汇总意见 ──
    ws3 = wb.create_sheet("汇总意见")
    ws3.merge_cells("A1:D1")
    ws3.cell(row=1, column=1, value="八专业汇总意见").font = title_font
    ws3.merge_cells("A3:D3")
    ws3.cell(row=3, column=1, value=review.get("summary", "")).font = normal_font
    ws3.cell(row=3, column=1).alignment = Alignment(wrap_text=True, vertical="top")
    ws3.row_dimensions[3].height = 200
    ws3.column_dimensions["A"].width = 80

    # ── Sheet 4: 操作日志 ──
    ws4 = wb.create_sheet("操作日志")
    headers4 = ["时间", "事件类型", "描述", "专业"]
    for c, h in enumerate(headers4, 1):
        ws4.cell(row=1, column=c, value=h)
    style_header(ws4, len(headers4))
    audit = get_audit_log(task_id, limit=100)
    for i, entry in enumerate(audit):
        row = i + 2
        ws4.cell(row=row, column=1, value=entry.get("createdAt", ""))
        ws4.cell(row=row, column=2, value=entry.get("eventType", ""))
        ws4.cell(row=row, column=3, value=entry.get("description", ""))
        ws4.cell(row=row, column=4, value=entry.get("profileCode", ""))
    style_data(ws4, 2, len(audit) + 1, len(headers4))
    ws4.column_dimensions["A"].width = 20
    ws4.column_dimensions["B"].width = 18
    ws4.column_dimensions["C"].width = 50
    ws4.column_dimensions["D"].width = 14

    from io import BytesIO
    output = BytesIO()
    wb.save(output)
    return output.getvalue()


def generate_batch_excel(task_ids: list) -> bytes | None:
    """批量导出多个任务的 Excel 汇总表"""
    try:
        from openpyxl import Workbook
        from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
    except ImportError:
        return None

    wb = Workbook()
    ws = wb.active
    ws.title = "审核批处理汇总"

    header_font = Font(name="微软雅黑", bold=True, size=11, color="FFFFFF")
    header_fill = PatternFill(start_color="1D4B79", end_color="1D4B79", fill_type="solid")
    normal_font = Font(name="微软雅黑", size=10)
    thin_border = Border(
        left=Side(style="thin"), right=Side(style="thin"),
        top=Side(style="thin"), bottom=Side(style="thin"),
    )

    headers = ["序号", "任务ID", "标题", "类型", "状态", "进度", "发送数", "错误数", "结论", "时间"]
    for c, h in enumerate(headers, 1):
        cell = ws.cell(row=1, column=c, value=h)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = thin_border

    for i, task_id in enumerate(task_ids):
        review = get_review(task_id)
        if not review:
            continue
        row = i + 2
        values = [
            i + 1,
            task_id,
            review.get("title", ""),
            review.get("modeLabel", ""),
            review.get("status", ""),
            f"{review.get('completedCount', 0)}/{review.get('reviewerCount', 0)}",
            review.get("sentCount", 0),
            review.get("errorCount", 0),
            review.get("conclusion", ""),
            review.get("createdAt", ""),
        ]
        for c, v in enumerate(values, 1):
            cell = ws.cell(row=row, column=c, value=v)
            cell.font = normal_font
            cell.border = thin_border

    ws.column_dimensions["A"].width = 6
    ws.column_dimensions["B"].width = 30
    ws.column_dimensions["C"].width = 40
    ws.column_dimensions["D"].width = 12
    ws.column_dimensions["E"].width = 10
    ws.column_dimensions["F"].width = 10
    ws.column_dimensions["G"].width = 8
    ws.column_dimensions["H"].width = 8
    ws.column_dimensions["I"].width = 30
    ws.column_dimensions["J"].width = 20

    from io import BytesIO
    output = BytesIO()
    wb.save(output)
    return output.getvalue()


# ============================================================================
# Profile 在线状态
# ============================================================================

def check_profile_status() -> dict:
    result = {"bots": [], "online": 0, "total": len(PROFILES_8), "generatedAt": now()}

    # Hermes 或 DeepSeek API 均为按需调用，机器人始终就绪
    for p in PROFILES_8:
        result["bots"].append({
            "profile": p["profile"], "name": p["name"], "role": p["role"],
            "order": p["order"], "online": True, "pid": "Hermes" if HERMES_PY.exists() else "API",
            "wecomConnected": False, "lastInboundAt": now(),
            "lastResponseAt": now(), "lastErrorAt": "",
        })
        result["online"] += 1
    try:
        result["recentTasks"] = cached("recent_tasks_status", 10, lambda: _fetch_recent_tasks())
    except Exception:
        result["recentTasks"] = []
    result["dbStats"] = stats()
    return result


# ============================================================================
# 文件上传
# ============================================================================

def extract_bid_fields(filepath: str, file_type: str) -> dict:
    """从上传文件中提取关键结构化字段：项目面积、服务范围、人员配置、报价限制等"""
    content = extract_file_content(filepath)
    fields = {"fileType": file_type, "extracted": {}}

    # 招标/投标文件关键词匹配
    area_patterns = [
        r"(?:总?(?:建筑|用地|规划|计容)?面积)[：:是为约]?\s*[\d,.\s]+[~至-]?\d*\s*(?:万?(?:㎡|平方米|m²|平米|公顷|ha|亩))",
        r"总?(?:建筑|用地)面积\D{0,10}(\d[\d,.]*(?:万)?\s*(?:㎡|平方米|m²|平米))",
    ]
    service_patterns = [
        r"(?:服务(?:范围|内容|标准|等级))[：:是为约]?\s*(.{5,100})",
        r"(?:物业服务(?:等级|标准|要求))[：:是为约]?\s*(.{5,100})",
    ]
    personnel_patterns = [
        r"(?:人员(?:配置|编制|数量|定编|需求))[：:是为约]?\s*(.{5,100})",
        r"(?:岗位(?:配置|编制|设置))[：:是为约]?\s*(.{5,100})",
    ]
    price_patterns = [
        r"(?:报价(?:上限|限制|范围|要求)?)[：:是为约]?\s*(.{5,100})",
        r"(?:物业费(?:单价|标准)?)[：:是为约]?\s*(.{5,120})",
        r"(?:投标(?:总价|报价|限价))[：:是为约]?\s*(.{5,100})",
    ]
    contract_patterns = [
        r"(?:合同(?:期限|周期|年限))[：:是为约]?\s*(.{5,60})",
        r"(?:保证金)[：:是为约]?\s*(.{5,80})",
    ]

    for name, patterns in [
        ("项目面积", area_patterns), ("服务范围", service_patterns),
        ("人员配置", personnel_patterns), ("报价限制", price_patterns),
        ("合同条款", contract_patterns),
    ]:
        for pat in patterns:
            m = re.search(pat, content, re.IGNORECASE)
            if m:
                val = m.group(1) if m.lastindex else m.group(0)
                fields["extracted"][name] = val.strip()
                break

    # 项目类型识别
    type_keywords = {
        "住宅": "住宅物业选聘", "写字楼": "写字楼/公建物业投标", "公建": "写字楼/公建物业投标",
        "顾问": "顾问/授权经营项目", "授权经营": "顾问/授权经营项目",
        "外包": "外包/自建转外包方案", "工程改造": "工程改造方案",
        "费用调整": "费用调整方案", "管理制度": "管理制度/通知方案",
        "运营方案": "内部运营方案", "整改": "整改专项方案",
        "招标": "市场拓展投标", "投标": "市场拓展投标", "选聘": "住宅物业选聘",
        "物业服务": "住宅物业选聘", "合同期限": "项目合同审核",
        "人员编制": "内部方案审核", "保证金": "项目合同审核",
    }
    for kw, proj_type in type_keywords.items():
        if kw in content:
            fields["detectedProjectType"] = proj_type
            break

    if not fields.get("detectedProjectType"):
        fields["detectedProjectType"] = "未知类型"

    return fields


def handle_upload(handler: SimpleHTTPRequestHandler) -> dict:
    content_type = handler.headers.get("Content-Type", "")
    if "multipart/form-data" not in content_type:
        return {"ok": False, "error": "需要 multipart/form-data"}

    boundary_match = re.search(r"boundary=([^;\s]+)", content_type)
    if not boundary_match:
        return {"ok": False, "error": "no boundary found"}
    boundary = boundary_match.group(1).encode()

    n = int(handler.headers.get("Content-Length") or 0)
    raw = handler.rfile.read(n)

    UPLOAD_DIR.mkdir(exist_ok=True)
    saved = []

    parts = raw.split(b"--" + boundary)
    for part in parts:
        if b"Content-Disposition" not in part:
            continue
        header_end = part.find(b"\r\n\r\n")
        if header_end == -1:
            continue
        headers = part[:header_end].decode(errors="ignore")
        body = part[header_end + 4:]
        body = body.rstrip(b"\r\n").rstrip(b"--")

        if not body:
            continue

        fn_match = re.search(r'filename="([^"]*)"', headers)
        if not fn_match:
            continue
        filename = fn_match.group(1)
        if not filename:
            continue

        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        stored_name = f"{ts}_{filename}"
        stored_path = UPLOAD_DIR / stored_name
        stored_path.write_bytes(body)

        content = extract_file_content(str(stored_path))
        ext = Path(filename).suffix.lower()
        file_type = ext.lstrip(".")
        extracted = extract_bid_fields(str(stored_path), file_type)

        saved.append({
            "filename": filename,
            "storedName": stored_name,
            "storedPath": str(stored_path),
            "size": len(body),
            "uploadedAt": now(),
            "content": content,
            "contentPreview": content[:200] if content else "",
            "fileType": file_type,
            "extractedFields": extracted.get("extracted", {}),
            "detectedProjectType": extracted.get("detectedProjectType", ""),
        })

    if saved:
        return {"ok": True, "files": saved}
    return {"ok": False, "error": "未找到有效文件"}


# ============================================================================
# 审核业务逻辑
# ============================================================================

def make_group_plan(mode: str, message: str, dry_run: bool = True) -> dict:
    mode = classify_mode(message, mode)
    task_id = "review_" + datetime.now().strftime("%Y%m%d_%H%M%S")
    if mode == "market":
        steps = [
            {"step": 1, "type": "send", "target": PROFILE_TF, "status": "pending", "title": "TF先行测算", "rule": "依据第一服务作业标准，结合AI分析，直接基于上传文件中的成本数据进行测算判断"},
            {"step": 2, "type": "wait", "target": None, "status": "blocked", "title": "等待TF测算结果", "rule": "七专业不能脱离TF测算先给泛泛风险"},
        ] + [
            {"step": p["order"], "type": "send_after_tf", "target": p, "status": "waiting_tf", "title": f"{p['role']}基于TF测算审核", "rule": "基于TF测算结果输出通过/条件通过/驳回"}
            for p in PROFILES_7
        ] + [
            {"step": 9, "type": "summary", "target": None, "status": "pending", "title": "生成七专业+TF汇总意见", "rule": "形成市场拓展审核结论和投标前置条件"}
        ]
        title = "市场拓展审核分发计划"
        warning = "当前为 dry-run：不会发送企微；真实发送前需确认TF测算触发和目标群。"
    elif mode == "internal":
        steps = [
            {"step": p["order"], "type": "parallel_send", "target": p, "status": "pending", "title": f"{p['role']}并行审核", "rule": "内部方案八专业并行；TF只审战略/业务价值，不得@七专业" if p["profile"] == "tf-invest" else "内部方案并行审核，不等待TF"}
            for p in PROFILES_8
        ] + [
            {"step": 9, "type": "summary", "target": None, "status": "pending", "title": "生成八专业汇总意见", "rule": "汇总必须修改项、条件通过项、责任部门、执行闭环"}
        ]
        title = "内部方案审核分发计划"
        warning = "当前为 dry-run：不会发送企微；真实发送前需确认附件和目标群。"
    else:
        steps = []
        title = "无法识别审核类型"
        warning = "请补充关键词：市场拓展/投标/招标/选聘，或内部方案/制度/外包/费用调整。"

    task = {
        "ok": mode != "unknown",
        "dryRun": dry_run,
        "taskId": task_id,
        "mode": mode,
        "title": title,
        "message": message,
        "status": "planned" if mode != "unknown" else "unknown",
        "createdAt": now(),
        "warning": warning,
        "steps": steps,
        "nextAction": "confirm_send_required" if mode != "unknown" else "edit_message",
    }
    TASK_DIR.mkdir(exist_ok=True)
    (TASK_DIR / f"{task_id}.json").write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")
    if mode != "unknown":
        log_event(task_id, "plan_created", f"审核计划已创建: {title}", metadata={"mode": mode, "steps_count": len(steps)})
    return task


def make_direct_reply(profile: str, message: str, mode: str = "") -> dict:
    target = profile_by_code(profile)
    task_id = "direct_" + datetime.now().strftime("%Y%m%d_%H%M%S")
    if not target:
        return {"ok": False, "error": f"unknown profile: {profile}"}
    mode = classify_mode(message, mode)
    if mode == "market":
        scope = "市场拓展/投标审核"
        rule = "单聊只返回本专业预审意见，不触发其他机器人；若为正式市场拓展审核，仍需先由TF测算。"
    elif mode == "internal":
        scope = "内部方案审核"
        rule = "单聊只返回本专业追问意见，不触发八专业并行；正式审核需走内部方案群聊入口。"
    else:
        scope = "专业单聊"
        rule = "未识别审核类型，仅作为本专业问答预览。"

    log_event(task_id, "direct_started", f"单聊开始: {target['name']}", profile_code=profile)
    reply, call_error = call_profile(target["profile"], target["role"], message, mode, rule)
    task = {
        "ok": not bool(call_error),
        "dryRun": False,
        "wecomSent": False,
        "taskId": task_id,
        "mode": mode,
        "scope": scope,
        "profile": target,
        "message": message,
        "reply": reply,
        "createdAt": now(),
        "rule": rule,
        "callError": call_error,
        "nextAction": "review_quality_then_enable_wecom_send",
        "status": "completed" if not call_error else "failed",
    }
    TASK_DIR.mkdir(exist_ok=True)
    (TASK_DIR / f"{task_id}.json").write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")
    # 保存到数据库
    save_review({
        "taskId": task_id, "mode": mode, "title": f"单聊{target['name']}",
        "message": message, "status": "completed" if not call_error else "failed",
        "source": "http-direct", "reviewerCount": 1, "completedCount": 1 if not call_error else 0,
        "sentCount": 1, "errorCount": 1 if call_error else 0,
        "results": [{"profile": target, "reply": reply, "error": call_error}],
        "createdAt": now(),
    })
    log_event(task_id, "direct_completed" if not call_error else "direct_failed",
              f"单聊{'完成' if not call_error else '失败'}: {target['name']}",
              profile_code=profile)
    return task


def make_group_send(mode: str, message: str, files: list = None, task_id: str | None = None) -> dict:
    mode = classify_mode(message, mode)
    task_id = task_id or ("group_send_" + datetime.now().strftime("%Y%m%d_%H%M%S"))
    save_review({
        "taskId": task_id,
        "mode": mode,
        "title": "审核任务执行中",
        "message": message,
        "status": "running",
        "source": "http",
        "reviewerCount": 8 if mode in {"internal", "market"} else 0,
        "completedCount": 0,
        "sentCount": 0,
        "errorCount": 0,
        "createdAt": now(),
        "startedAt": now(),
        "currentPhase": "starting",
    })

    def write_task_progress(payload: dict) -> None:
        write_progress(task_id, payload, sync_db=True)

    log_event(task_id, "group_send_started", f"群发审核开始: {mode}", metadata={"mode": mode})

    file_contents = ""
    if files:
        for f in files:
            if f.get("content") and not f["content"].startswith("["):
                file_contents += f"\n--- 文件: {f.get('filename', '未知')} ---\n{f['content']}\n"

    full_msg = message
    if files:
        file_names = ", ".join(f.get("filename", "未知文件") for f in files)
        full_msg = f"{message}\n\n【附加上传文件】：{file_names}"

    if mode == "internal":
        results = []
        reviewer_count = 8
        write_task_progress({
            "total": 16, "completed": 0, "done": [], "current": "starting",
            "status": "running", "mode": "internal", "phase": "calling_profiles",
        })

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
            futs = {}
            for p in PROFILES_8:
                rule = (
                    "内部方案审核：必须依据第一服务相关作业标准进行审核判断。TF只审战略/业务价值，禁止@七专业。"
                    if p["profile"] == "tf-invest"
                    else f"内部方案审核：必须依据第一服务{p['role']}相关作业标准进行专业审核判断，结合参考知识中的标准条款给出具体意见。"
                )
                fut = ex.submit(call_profile, p["profile"], p["role"], full_msg, "internal", rule, file_contents)
                futs[fut] = p
            for fut in concurrent.futures.as_completed(futs):
                p = futs[fut]
                reply, err = fut.result()
                results.append({"profile": p, "reply": reply, "error": err})
                log_event(task_id, "profile_called", f"{p['name']} 审核完成", profile_code=p['profile'])
                write_task_progress({
                    "total": 16, "completed": len(results),
                    "done": [r["profile"]["profile"] for r in results],
                    "current": p["name"], "status": "running", "mode": "internal",
                    "phase": "calling_profiles",
                })

        results.sort(key=lambda r: r["profile"]["order"])
        sent = []
        send_errors = 0
        for r in results:
            write_task_progress({
                "total": 16, "completed": 8 + len(sent),
                "done": [x["profile"]["profile"] for x in results],
                "sent": [x["profile"]["profile"] for x in sent],
                "current": r["profile"]["name"], "status": "running", "mode": "internal",
                "phase": "sending_wecom",
            })
            wecom_msg = f"{r['profile']['name']}：\n{r['reply']}"
            send_res = send_wecom_message(wecom_msg)
            sent.append({**r, "wecomResult": send_res})
            if not send_res.get("ok"):
                send_errors += 1
                log_event(task_id, "wecom_send_failed", f"{r['profile']['name']} 企微发送失败", profile_code=r['profile']['profile'])
            else:
                log_event(task_id, "wecom_sent", f"{r['profile']['name']} 已发企微", profile_code=r['profile']['profile'])
            time.sleep(1.0)

        task = {
            "ok": send_errors == 0,
            "taskId": task_id,
            "mode": "internal",
            "title": "内部方案审核 · 八专业已并行发送",
            "message": full_msg,
            "results": sent,
            "sentCount": len(sent),
            "errorCount": send_errors,
            "reviewerCount": reviewer_count,
            "completedCount": len(sent),
            "status": "completed" if send_errors == 0 else "partial",
            "createdAt": now(),
            "nextAction": "generate_summary",
        }
        write_task_progress({
            "total": 16, "completed": 16,
            "done": [r["profile"]["profile"] for r in results],
            "sent": [r["profile"]["profile"] for r in sent],
            "current": "done", "status": "complete", "mode": "internal",
            "phase": "complete", "result": task,
        })
        log_event(task_id, "group_send_completed", f"群发完成: {len(sent)}条, 错误{send_errors}")

    elif mode == "market":
        # 市场拓展完整闭环：TF测算 → 企微发送 → 七专业基于TF并行审核 → 企微发送 → 自动汇总
        total_steps = 18  # TF调用(1) + TF企微(1) + 7调用(7) + 7企微(7) + 汇总(1) + 完成(1)
        reviewer_count = 8
        all_results = []

        # ── 阶段1: TF测算 ──
        write_task_progress({
            "total": total_steps, "completed": 0, "done": [], "sent": [],
            "current": PROFILE_TF["name"], "status": "running", "mode": "market",
            "phase": "calling_tf", "phaseLabel": "第一步：TF先行测算",
        })
        tf_reply, tf_err = call_profile(
            PROFILE_TF["profile"], PROFILE_TF["role"], full_msg, "market",
            "依据第一服务作业标准，结合AI分析，直接基于上传文件中的成本数据进行测算判断，不要要求额外签批文件。文件中的数据即为测算依据。", file_contents,
        )
        log_event(task_id, "tf_called", "TF测算完成", profile_code=PROFILE_TF["profile"])
        write_task_progress({
            "total": total_steps, "completed": 1, "done": [PROFILE_TF["profile"]],
            "sent": [], "current": "发送TF到企微", "status": "running", "mode": "market",
            "phase": "sending_tf_wecom", "phaseLabel": "第一步：TF发送企微",
        })

        # ── 阶段2: TF发送企微 ──
        tf_wecom_msg = f"【第一步：TF先行测算】\n{PROFILE_TF['name']}：\n{tf_reply}\n\n⚠️ 请等待七专业基于以上测算结果进行审核..."
        tf_send_res = send_wecom_message(tf_wecom_msg)
        log_event(task_id, "wecom_sent" if tf_send_res.get("ok") else "wecom_failed",
                  f"TF已发企微" if tf_send_res.get("ok") else "TF企微发送失败",
                  profile_code=PROFILE_TF["profile"])
        all_results.append({"profile": PROFILE_TF, "reply": tf_reply, "error": tf_err, "wecomResult": tf_send_res, "phase": "tf_step"})
        write_task_progress({
            "total": total_steps, "completed": 2,
            "done": [PROFILE_TF["profile"]], "sent": [PROFILE_TF["profile"]] if tf_send_res.get("ok") else [],
            "current": "启动七专业并行审核", "status": "running", "mode": "market",
            "phase": "calling_seven", "phaseLabel": "第二步：七专业基于TF测算并行审核",
        })

        # ── 阶段3: 构建带TF测算上下文的七专业prompt，并行调用 ──
        tf_context = f"""
【TF先行测算结果】（七专业审核必须基于此测算进行判断，不得脱离测算给泛泛风险）
{PROFILE_TF['name']}：
{tf_reply}
---
"""
        seven_results = []
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
            futs = {}
            for p in PROFILES_7:
                rule = f"市场拓展七专业审核：依据第一服务{p['role']}相关作业标准，结合AI分析，基于TF测算结果输出本专业判断。{p['role']}重点审核本专业范围内的事项，引用具体标准条款。"
                seven_full_msg = tf_context + "\n【原始审核材料】\n" + full_msg
                fut = ex.submit(call_profile, p["profile"], p["role"], seven_full_msg, "market", rule, file_contents)
                futs[fut] = p
            for fut in concurrent.futures.as_completed(futs):
                p = futs[fut]
                reply, err = fut.result()
                seven_results.append({"profile": p, "reply": reply, "error": err})
                log_event(task_id, "profile_called", f"{p['name']}(七专业)审核完成", profile_code=p["profile"])
                current_done_count = 3 + len(seven_results)
                write_task_progress({
                    "total": total_steps, "completed": current_done_count,
                    "done": [PROFILE_TF["profile"]] + [r["profile"]["profile"] for r in seven_results],
                    "sent": [PROFILE_TF["profile"]] if tf_send_res.get("ok") else [],
                    "current": p["name"], "status": "running", "mode": "market",
                    "phase": "calling_seven", "phaseLabel": f"第二步：七专业并行审核 ({len(seven_results)}/7)",
                })

        seven_results.sort(key=lambda r: r["profile"]["order"])
        write_task_progress({
            "total": total_steps, "completed": 10,
            "done": [PROFILE_TF["profile"]] + [r["profile"]["profile"] for r in seven_results],
            "sent": [PROFILE_TF["profile"]] if tf_send_res.get("ok") else [],
            "current": "发送七专业到企微", "status": "running", "mode": "market",
            "phase": "sending_seven_wecom", "phaseLabel": "第三步：七专业审核意见发送企微",
        })

        # ── 阶段4: 七专业逐个发送企微 ──
        send_errors = 0 if tf_send_res.get("ok") else 1
        for i, r in enumerate(seven_results):
            write_task_progress({
                "total": total_steps, "completed": 10 + i,
                "done": [PROFILE_TF["profile"]] + [x["profile"]["profile"] for x in seven_results],
                "sent": [PROFILE_TF["profile"]] if tf_send_res.get("ok") else [],
                "current": f"发送{r['profile']['name']}到企微", "status": "running", "mode": "market",
                "phase": "sending_seven_wecom", "phaseLabel": f"第三步：发送七专业 ({i+1}/7)",
            })
            wecom_msg = f"【第二步：七专业并行审核】\n{r['profile']['name']}（基于TF测算审核）：\n{r['reply']}"
            send_res = send_wecom_message(wecom_msg)
            r["wecomResult"] = send_res
            all_results.append({**r, "phase": "seven_step"})
            if not send_res.get("ok"):
                send_errors += 1
                log_event(task_id, "wecom_send_failed", f"{r['profile']['name']}企微发送失败", profile_code=r['profile']['profile'])
            else:
                log_event(task_id, "wecom_sent", f"{r['profile']['name']}已发企微", profile_code=r['profile']['profile'])
            time.sleep(1.0)

        # ── 阶段5: 自动生成汇总 ──
        write_task_progress({
            "total": total_steps, "completed": 17,
            "done": [PROFILE_TF["profile"]] + [r["profile"]["profile"] for r in seven_results],
            "sent": [PROFILE_TF["profile"]] if tf_send_res.get("ok") else [],
            "current": "生成八专业汇总意见", "status": "running", "mode": "market",
            "phase": "summarizing", "phaseLabel": "第四步：自动生成汇总意见",
        })

        all_sorted = [all_results[0]] + sorted(
            [r for r in all_results if r.get("phase") == "seven_step"],
            key=lambda r: r["profile"]["order"]
        )

        task = {
            "ok": send_errors == 0,
            "taskId": task_id,
            "mode": "market",
            "title": "市场拓展审核 · TF测算 + 七专业并行审核已完成",
            "message": full_msg,
            "results": all_sorted,
            "tfResult": {"profile": PROFILE_TF, "reply": tf_reply, "wecomResult": tf_send_res},
            "sentCount": len(all_sorted),
            "errorCount": send_errors,
            "reviewerCount": reviewer_count,
            "completedCount": len(all_sorted),
            "status": "completed" if send_errors == 0 else "partial",
            "createdAt": now(),
            "nextAction": "generate_summary",
        }

        write_task_progress({
            "total": total_steps, "completed": total_steps,
            "done": [PROFILE_TF["profile"]] + [r["profile"]["profile"] for r in seven_results],
            "sent": [r["profile"]["profile"] for r in all_sorted if r.get("wecomResult", {}).get("ok")],
            "current": "done", "status": "complete", "mode": "market",
            "phase": "complete", "phaseLabel": "✅ 市场拓展审核全链路完成",
            "result": task,
        })
        log_event(task_id, "group_send_completed", f"市场拓展全链路完成: TF+{len(seven_results)}专业, 错误{send_errors}")

        # 自动入库后触发汇总
        save_review(task)
        try:
            summary_result = make_summary(task_id)
            if summary_result.get("ok"):
                task["summary"] = summary_result.get("summary", "")
                task["conclusion"] = summary_result.get("conclusion", "")
                write_task_progress({
                    "total": total_steps, "completed": total_steps,
                    "done": [PROFILE_TF["profile"]] + [r["profile"]["profile"] for r in seven_results],
                    "sent": [r["profile"]["profile"] for r in all_sorted if r.get("wecomResult", {}).get("ok")],
                    "current": "done", "status": "complete", "mode": "market",
                    "phase": "complete", "phaseLabel": "✅ 市场拓展审核全链路完成（含汇总）",
                    "result": task, "summary": summary_result,
                })
        except Exception as e:
            log_event(task_id, "summary_failed", f"自动汇总失败: {e}")

        return task

    else:
        task = {"ok": False, "error": "无法识别审核类型", "message": full_msg, "taskId": task_id, "status": "failed"}
        write_task_progress({"total": 0, "completed": 0, "status": "failed", "mode": mode, "error": task["error"]})
        log_event(task_id, "group_send_failed", "无法识别审核类型")

    TASK_DIR.mkdir(exist_ok=True)
    (TASK_DIR / f"{task_id}.json").write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")
    if task.get("ok") or task.get("mode") in {"internal", "market"}:
        save_review(task)

    return task


def start_group_send_async(mode: str, message: str, files: list = None) -> dict:
    mode = classify_mode(message, mode)
    task_id = "group_send_" + datetime.now().strftime("%Y%m%d_%H%M%S")
    PROGRESS_DIR.mkdir(exist_ok=True)
    total = 16 if mode == "internal" else 18 if mode == "market" else 0
    initial = {
        "taskId": task_id, "mode": mode, "total": total, "completed": 0,
        "done": [], "sent": [], "current": "queued", "status": "queued",
        "phase": "queued", "createdAt": now(),
    }
    save_review({
        "taskId": task_id, "mode": mode, "title": "审核任务已排队",
        "message": message, "status": "queued", "source": "http",
        "reviewerCount": total, "completedCount": 0, "sentCount": 0,
        "errorCount": 0, "createdAt": initial["createdAt"], "startedAt": initial["createdAt"],
        "currentPhase": "queued", "progress": initial,
    })
    write_progress(task_id, initial, sync_db=True)
    log_event(task_id, "async_started", f"异步群发任务已入队: {mode}")

    def runner() -> None:
        try:
            make_group_send(mode, message, files, task_id=task_id)
        except Exception as e:
            err = {
                "taskId": task_id, "mode": mode, "total": total, "completed": 0,
                "status": "failed", "phase": "failed", "current": "failed",
                "error": str(e), "updatedAt": now(),
            }
            write_progress(task_id, err, sync_db=True)
            log_event(task_id, "async_failed", f"异步任务失败: {e}")

    t = __import__("threading").Thread(target=runner, daemon=True, name=f"review-send-{task_id}")
    t.start()
    return {"ok": True, "async": True, "taskId": task_id, "mode": mode, "progress": initial}


# ============================================================================
# HTTP Handler
# ============================================================================

class Handler(SimpleHTTPRequestHandler):
    server_version = "FirstServiceReviewUI/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(UI_DIR), **kwargs)

    def log_message(self, fmt, *args):
        log_debug("HTTP %s", fmt % args)

    def log_request(self, code="-", size="-"):
        log_info("HTTP %s %s → %s %s", self.command, self.path, code, size)

    def _json(self, status: int, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    # ── GET ────────────────────────────────────────────────────────────────

    def do_GET(self):
        if self.path.startswith("/api/") and not check_rate_limit(self):
            self._json(429, {"error": "请求过于频繁，请稍后再试"})
            return
        # 健康检查
        if self.path == "/health" or self.path.startswith("/health?"):
            self._json(200, {"ok": True, "ui_dir": str(UI_DIR), "version": "1.1", "ws": True, "db": str(DB_PATH)})
            return

        # 当前用户
        if self.path == "/api/auth/me":
            user = require_auth(self)
            if user:
                self._json(200, {"ok": True, "user": user})
            else:
                self._json(401, {"ok": False, "error": "未登录"})
            return

        # 实时状态
        if self.path == "/api/status" or self.path.startswith("/api/status?"):
            if not require_auth(self):
                self._json(401, {"ok": False, "error": "请先登录"})
                return
            self._json(200, check_profile_status())
            return

        # 审核历史详情
        if self.path.startswith("/api/review/history/") and not self.path.startswith("/api/review/history?"):
            if not require_auth(self):
                self._json(401, {"ok": False, "error": "请先登录"})
                return
            task_id = self.path.replace("/api/review/history/", "").split("?")[0]
            review = get_review(task_id)
            if review:
                self._json(200, {"ok": True, "review": review})
            else:
                self._json(404, {"ok": False, "error": "review not found"})
            return

        # 审核历史列表（支持分页）
        if self.path.startswith("/api/review/history"):
            if not require_auth(self):
                self._json(401, {"ok": False, "error": "请先登录"})
                return
            params = {}
            if "?" in self.path:
                from urllib.parse import parse_qs
                qs = self.path.split("?", 1)[1]
                params = {k: v[0] for k, v in parse_qs(qs).items()}
            limit = min(int(params.get("limit", 20)), 100)
            offset = int(params.get("offset", 0))
            result = get_history(
                limit=limit, offset=offset,
                mode=params.get("mode", ""),
                status=params.get("status", ""),
                q=params.get("q", ""),
            )
            result["ok"] = True
            result["stats"] = stats()
            self._json(200, result)
            return

        # 审核统计
        if self.path == "/api/review/stats":
            if not require_auth(self):
                self._json(401, {"ok": False, "error": "请先登录"})
                return
            self._json(200, {"ok": True, "stats": stats()})
            return

        # 模板列表
        # 模板管理 CRUD
        if self.path == "/api/templates" or self.path.startswith("/api/templates?"):
            if not require_auth(self):
                self._json(401, {"ok": False, "error": "请先登录"})
                return
            if self.command == "POST":
                user = require_auth(self)
                if not check_permission(user, "manager"):
                    self._json(403, {"ok": False, "error": "需要管理员权限"})
                    return
                data = read_body(self)
                self._json(200, add_template(data))
                return
            if self.command == "PUT":
                user = require_auth(self)
                if not check_permission(user, "manager"):
                    self._json(403, {"ok": False, "error": "需要管理员权限"})
                    return
                data = read_body(self)
                tpl_id = str(data.get("id") or "").strip()
                if not tpl_id:
                    self._json(400, {"ok": False, "error": "id required"})
                    return
                self._json(200, update_template(tpl_id, data))
                return
            if self.command == "DELETE":
                user = require_auth(self)
                if not check_permission(user, "manager"):
                    self._json(403, {"ok": False, "error": "需要管理员权限"})
                    return
                data = read_body(self)
                tpl_id = str(data.get("id") or "").strip()
                if not tpl_id:
                    self._json(400, {"ok": False, "error": "id required"})
                    return
                self._json(200, delete_template(tpl_id))
                return
            self._json(200, {"ok": True, "templates": list_templates()})
            return

        # 全文搜索
        if self.path == "/api/review/search":
            if not require_auth(self):
                self._json(401, {"ok": False, "error": "请先登录"})
                return
            params = {}
            if "?" in self.path:
                from urllib.parse import parse_qs
                qs = self.path.split("?", 1)[1]
                params = {k: v[0] for k, v in parse_qs(qs).items()}
            q = str(params.get("q", "")).strip()
            if not q or len(q) < 2:
                self._json(400, {"ok": False, "error": "搜索词至少2个字符"})
                return
            results = []
            with db_lock:
                db = get_db()
                rows = db.execute(
                    "SELECT r.task_id, r.title, r.status, r.mode, r.created_at, o.profile_code, o.profile_name, o.reply "
                    "FROM reviews r LEFT JOIN review_opinions o ON r.task_id = o.task_id "
                    "WHERE r.title LIKE ? OR r.message LIKE ? OR o.reply LIKE ? "
                    "ORDER BY r.created_at DESC LIMIT 50",
                    (f"%{q}%", f"%{q}%", f"%{q}%")
                ).fetchall()
                for row in rows:
                    results.append({
                        "taskId": row[0], "title": row[1], "status": row[2],
                        "mode": row[3], "createdAt": row[4],
                        "profileCode": row[5], "profileName": row[6],
                        "replySnippet": (row[7] or "")[:200] if row[7] else "",
                    })
            self._json(200, {"ok": True, "q": q, "results": results, "total": len(results)})
            return

        # 审核分析
        if self.path == "/api/review/analytics":
            if not require_auth(self):
                self._json(401, {"ok": False, "error": "请先登录"})
                return
            self._json(200, get_analytics())
            return

        # ── APH 决策平台代理 ──────────────────────────────────────────
        if self.path.startswith("/api/aph/north/budget"):
            import aph_proxy
            aph = aph_proxy.get_proxy()
            result = aph.get_north_china_budget()
            self._json(200, result)
            return
        if self.path.startswith("/api/aph/north/notices"):
            import aph_proxy
            aph = aph_proxy.get_proxy()
            result = aph.get_north_china_notices()
            self._json(200, result)
            return
        if self.path.startswith("/api/aph/north/warnings"):
            import aph_proxy
            aph = aph_proxy.get_proxy()
            result = aph.get_north_china_warnings()
            self._json(200, result)
            return
        if self.path.startswith("/api/aph/"):
            import aph_proxy
            aph = aph_proxy.get_proxy()
            real_path = self.path.replace("/api/aph/", "")
            result = aph.get(real_path)
            if result.get("ok") is False:
                self._json(500, result)
            else:
                self._json(200, result)
            return

        # 审核意见（逐条）
        if self.path.startswith("/api/review/opinions/") and not self.path.startswith("/api/review/opinions?"):
            if not require_auth(self):
                self._json(401, {"ok": False, "error": "请先登录"})
                return
            task_id = self.path.replace("/api/review/opinions/", "").split("?")[0]
            opinions = get_task_opinions(task_id)
            summary = get_task_summary(task_id)
            self._json(200, {"ok": True, "taskId": task_id, "opinions": opinions, "summary": summary})
            return

        # 审计日志
        if self.path.startswith("/api/review/audit/"):
            if not require_auth(self):
                self._json(401, {"ok": False, "error": "请先登录"})
                return
            task_id = self.path.replace("/api/review/audit/", "").split("?")[0]
            self._json(200, {"ok": True, "audit": get_audit_log(task_id)})
            return

        # 任务管理列表
        if self.path == "/api/tasks" or self.path.startswith("/api/tasks?"):
            if not require_auth(self):
                self._json(401, {"ok": False, "error": "请先登录"})
                return
            params = {}
            if "?" in self.path:
                from urllib.parse import parse_qs
                qs = self.path.split("?", 1)[1]
                params = {k: v[0] for k, v in parse_qs(qs).items()}
            limit = min(int(params.get("limit", 20)), 100)
            offset = int(params.get("offset", 0))
            result = get_history(
                limit=limit, offset=offset,
                mode=params.get("mode", ""),
                status=params.get("status", ""),
                q=params.get("q", ""),
            )
            result["ok"] = True
            self._json(200, result)
            return

        # 统一任务状态查询
        if self.path.startswith("/api/tasks/") and self.path.endswith("/state"):
            if not require_auth(self):
                self._json(401, {"ok": False, "error": "请先登录"})
                return
            task_id = self.path.replace("/api/tasks/", "").rsplit("/state", 1)[0]
            state = get_task_state(task_id)
            if state:
                self._json(200, state)
            else:
                self._json(404, {"ok": False, "error": "task state not found"})
            return

        # 进度查询
        if self.path.startswith("/api/review/progress/"):
            if not require_auth(self):
                self._json(401, {"ok": False, "error": "请先登录"})
                return
            task_id = self.path.replace("/api/review/progress/", "").split("?")[0]
            progress = read_progress(task_id)
            review = get_review(task_id)
            if progress:
                if review:
                    progress.setdefault("review", review)
                    progress.setdefault("dbStatus", review.get("status"))
                    progress.setdefault("currentPhase", review.get("currentPhase"))
                self._json(200, progress)
            elif review:
                self._json(200, {"ok": True, "taskId": task_id, "status": review.get("status"), "currentPhase": review.get("currentPhase"), "review": review})
            else:
                self._json(404, {"ok": False, "error": "progress not found"})
            return

        # 汇总生成
        if self.path.startswith("/api/review/summary/"):
            if not check_permission(require_auth(self), "reviewer"):
                self._json(401 if not require_auth(self) else 403, {"ok": False, "error": "需要审核员权限"})
                return
            task_id = self.path.rsplit("/", 1)[-1]
            self._json(200, make_summary(task_id))
            return

        # 导出报告 - Markdown
        if self.path.startswith("/api/review/export/md/") and not self.path.startswith("/api/review/export/md?"):
            if not require_auth(self):
                self._json(401, {"ok": False, "error": "请先登录"})
                return
            task_id = self.path.replace("/api/review/export/md/", "").split("?")[0]
            md = generate_markdown_report(task_id)
            if md.startswith("ERROR:"):
                self._json(404, {"ok": False, "error": md})
                return
            body = md.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/markdown; charset=utf-8")
            self.send_header("Content-Disposition", f"attachment; filename=review_{task_id}.md")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # 导出报告 - Excel
        if self.path.startswith("/api/review/export/xlsx/") and not self.path.startswith("/api/review/export/xlsx?"):
            if not require_auth(self):
                self._json(401, {"ok": False, "error": "请先登录"})
                return
            task_id = self.path.replace("/api/review/export/xlsx/", "").split("?")[0]
            xlsx = generate_excel_report(task_id)
            if xlsx is None:
                self._json(400, {"ok": False, "error": "openpyxl not installed or task not found"})
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Disposition", f"attachment; filename=review_{task_id}.xlsx")
            self.send_header("Content-Length", str(len(xlsx)))
            self.end_headers()
            self.wfile.write(xlsx)
            return

        # 兼容旧版导出路径
        if self.path.startswith("/api/review/export/") and not self.path.startswith("/api/review/export/md") and not self.path.startswith("/api/review/export/xlsx"):
            if not require_auth(self):
                self._json(401, {"ok": False, "error": "请先登录"})
                return
            task_id = self.path.replace("/api/review/export/", "").split("?")[0]
            md = generate_markdown_report(task_id)
            if md.startswith("ERROR:"):
                self._json(404, {"ok": False, "error": md})
                return
            body = md.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/markdown; charset=utf-8")
            self.send_header("Content-Disposition", f"attachment; filename=review_{task_id}.md")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # 上传文件访问
        if self.path.startswith("/uploads/"):
            file_path = UPLOAD_DIR / self.path.replace("/uploads/", "")
            if file_path.exists() and file_path.is_file():
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(file_path.stat().st_size))
                self.end_headers()
                self.wfile.write(file_path.read_bytes())
            else:
                self._json(404, {"ok": False, "error": "file not found"})
            return

        return super().do_GET()

    # ── POST ───────────────────────────────────────────────────────────────

    def do_POST(self):
        if not check_rate_limit(self):
            self._json(429, {"error": "请求过于频繁，请稍后再试"})
            return
        # 登录
        if self.path == "/api/auth/login":
            data = read_body(self)
            username = str(data.get("username") or "").strip()
            password = str(data.get("password") or "")
            if not username or not password:
                self._json(400, {"ok": False, "error": "缺少用户名或密码"})
                return
            result = authenticate(username, password)
            if result:
                self._json(200, result)
            else:
                self._json(401, {"ok": False, "error": "用户名或密码错误"})
            return

        # 登出
        if self.path == "/api/auth/logout":
            auth_header = self.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                destroy_session(auth_header[7:])
            self._json(200, {"ok": True, "message": "已登出"})
            return

        # 刷新 data.js
        if self.path == "/api/refresh":
            user = require_auth(self)
            if not check_permission(user, "admin"):
                self._json(401 if not user else 403, {"ok": False, "error": "需要管理员权限"})
                return
            try:
                p = subprocess.run([sys.executable, str(BUILD)], cwd=str(UI_DIR), capture_output=True, text=True, timeout=45)
                self._json(200 if p.returncode == 0 else 500, {"ok": p.returncode == 0, "output": (p.stdout + p.stderr)[-4000:]})
            except Exception as e:
                self._json(500, {"ok": False, "error": str(e)})
            return

        # 文件上传
        if self.path == "/api/upload":
            user = require_auth(self)
            if not check_permission(user, "reviewer"):
                self._json(401 if not user else 403, {"ok": False, "error": "需要审核员权限"})
                return
            res = handle_upload(self)
            self._json(200 if res.get("ok") else 400, res)
            return

        # 审核计划（dry-run）
        if self.path == "/api/review/group":
            user = require_auth(self)
            if not check_permission(user, "reviewer"):
                self._json(401 if not user else 403, {"ok": False, "error": "需要审核员权限"})
                return
            data = read_body(self)
            msg = str(data.get("message") or "").strip()
            mode = str(data.get("mode") or "").strip()
            if not msg:
                self._json(400, {"ok": False, "error": "message required"})
                return
            self._json(200, make_group_plan(mode, msg, dry_run=True))
            return

        # 真实群发
        if self.path == "/api/review/group/send":
            user = require_auth(self)
            if not check_permission(user, "reviewer"):
                self._json(401 if not user else 403, {"ok": False, "error": "需要审核员权限"})
                return
            data = read_body(self)
            msg = str(data.get("message") or "").strip()
            mode = str(data.get("mode") or "").strip()
            files = data.get("files", None)
            if not msg:
                self._json(400, {"ok": False, "error": "message required"})
                return
            async_mode = data.get("async", False)
            res = start_group_send_async(mode, msg, files) if async_mode else make_group_send(mode, msg, files)
            self._json(200 if res.get("ok") else 500, res)
            return

        # 单聊
        if self.path == "/api/review/direct":
            user = require_auth(self)
            if not check_permission(user, "reviewer"):
                self._json(401 if not user else 403, {"ok": False, "error": "需要审核员权限"})
                return
            data = read_body(self)
            msg = str(data.get("message") or "").strip()
            profile = str(data.get("profile") or "").strip()
            mode = str(data.get("mode") or "").strip()
            if not msg or not profile:
                self._json(400, {"ok": False, "error": "message and profile required"})
                return
            res = make_direct_reply(profile, msg, mode)
            self._json(200 if res.get("ok") else 400, res)
            return

        # 生成汇总
        if self.path == "/api/review/summary":
            user = require_auth(self)
            if not check_permission(user, "reviewer"):
                self._json(401 if not user else 403, {"ok": False, "error": "需要审核员权限"})
                return
            data = read_body(self)
            task_id = str(data.get("taskId") or "").strip()
            if not task_id:
                self._json(400, {"ok": False, "error": "taskId required"})
                return
            self._json(200, make_summary(task_id))
            return

        # 质量评估
        if self.path.startswith("/api/review/quality/") and not self.path.startswith("/api/review/quality?"):
            if not require_auth(self):
                self._json(401, {"ok": False, "error": "请先登录"})
                return
            task_id = self.path.replace("/api/review/quality/", "").split("?")[0]
            self._json(200, assess_task_quality(task_id))
            return

        # 重新审核
        if self.path == "/api/review/re-review":
            user = require_auth(self)
            if not check_permission(user, "reviewer"):
                self._json(401 if not user else 403, {"ok": False, "error": "需要审核员权限"})
                return
            data = read_body(self)
            task_id = str(data.get("taskId") or "").strip()
            profile = str(data.get("profile") or "").strip()
            if not task_id or not profile:
                self._json(400, {"ok": False, "error": "taskId and profile required"})
                return
            self._json(200, re_review_profile(task_id, profile))
            return

        # 批量导出 Excel
        if self.path == "/api/review/export/batch":
            user = require_auth(self)
            if not check_permission(user, "manager"):
                self._json(401 if not user else 403, {"ok": False, "error": "需要管理员权限"})
                return
            data = read_body(self)
            task_ids = data.get("taskIds", [])
            if not task_ids:
                self._json(400, {"ok": False, "error": "taskIds required"})
                return
            xlsx = generate_batch_excel(task_ids)
            if xlsx is None:
                self._json(400, {"ok": False, "error": "openpyxl not installed"})
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
            self.send_header("Content-Disposition", "attachment; filename=review_batch.xlsx")
            self.send_header("Content-Length", str(len(xlsx)))
            self.end_headers()
            self.wfile.write(xlsx)
            return

        # 用户管理 - 列出所有用户（管理员）
        if self.path == "/api/admin/users":
            user = require_auth(self)
            if not check_permission(user, "admin"):
                self._json(401 if not user else 403, {"ok": False, "error": "需要管理员权限"})
                return
            users = load_users()
            user_list = []
            for uname, info in users.items():
                user_list.append({
                    "username": uname,
                    "display_name": info.get("display_name", uname),
                    "role": info.get("role", "reviewer"),
                    "created_at": info.get("created_at", ""),
                })
            self._json(200, {"ok": True, "users": user_list})
            return

        # 用户管理 - 添加/更新用户（管理员）
        if self.path == "/api/admin/users/add":
            user = require_auth(self)
            if not check_permission(user, "admin"):
                self._json(401 if not user else 403, {"ok": False, "error": "需要管理员权限"})
                return
            data = read_body(self)
            username = str(data.get("username") or "").strip()
            password = str(data.get("password") or "")
            display_name = str(data.get("display_name") or "").strip()
            role = str(data.get("role") or "reviewer").strip()
            if not username or not password:
                self._json(400, {"ok": False, "error": "用户名和密码不能为空"})
                return
            if role not in ROLE_LEVEL:
                self._json(400, {"ok": False, "error": f"无效角色: {role}，可选: {list(ROLE_LEVEL.keys())}"})
                return
            users = load_users()
            users[username] = {
                "password_hash": hashlib.sha256(password.encode()).hexdigest(),
                "display_name": display_name or username,
                "role": role,
                "created_at": users.get(username, {}).get("created_at", datetime.now().strftime("%Y-%m-%d")),
            }
            USERS_FILE.write_text(json.dumps(users, ensure_ascii=False, indent=2), encoding="utf-8")
            log_info("User %s created/updated by admin (role=%s)", username, role)
            self._json(200, {"ok": True, "message": f"用户 {username} 已更新"})
            return

        # 用户管理 - 删除用户（管理员）
        if self.path == "/api/admin/users/delete":
            user = require_auth(self)
            if not check_permission(user, "admin"):
                self._json(401 if not user else 403, {"ok": False, "error": "需要管理员权限"})
                return
            data = read_body(self)
            target = str(data.get("username") or "").strip()
            if not target:
                self._json(400, {"ok": False, "error": "用户名不能为空"})
                return
            current = user.get("username", "")
            if target == current:
                self._json(400, {"ok": False, "error": "不能删除自己"})
                return
            users = load_users()
            if target not in users:
                self._json(404, {"ok": False, "error": "用户不存在"})
                return
            del users[target]
            USERS_FILE.write_text(json.dumps(users, ensure_ascii=False, indent=2), encoding="utf-8")
            log_info("User %s deleted by admin %s", target, current)
            self._json(200, {"ok": True, "message": f"用户 {target} 已删除"})
            return

        # 修改密码（任何登录用户可修改自己密码）
        if self.path == "/api/auth/change-password":
            cu = require_auth(self)
            if not cu:
                self._json(401, {"ok": False, "error": "请先登录"})
                return
            data = read_body(self)
            old_pw = str(data.get("old_password") or "")
            new_pw = str(data.get("new_password") or "")
            if not old_pw or not new_pw:
                self._json(400, {"ok": False, "error": "新旧密码均不能为空"})
                return
            if len(new_pw) < 6:
                self._json(400, {"ok": False, "error": "新密码至少6位"})
                return
            users = load_users()
            uname = cu["username"]
            uinfo = users.get(uname)
            if not uinfo:
                self._json(404, {"ok": False, "error": "用户不存在"})
                return
            if hashlib.sha256(old_pw.encode()).hexdigest() != uinfo.get("password_hash", ""):
                self._json(403, {"ok": False, "error": "旧密码不正确"})
                return
            users[uname]["password_hash"] = hashlib.sha256(new_pw.encode()).hexdigest()
            USERS_FILE.write_text(json.dumps(users, ensure_ascii=False, indent=2), encoding="utf-8")
            self._json(200, {"ok": True, "message": "密码已修改"})
            return

        # 模板管理 - POST 创建
        if self.path == "/api/templates" or self.path.startswith("/api/templates?"):
            user = require_auth(self)
            if not check_permission(user, "manager"):
                self._json(401 if not user else 403, {"ok": False, "error": "需要管理员权限"})
                return
            data = read_body(self)
            self._json(200, add_template(data))
            return

        self._json(404, {"ok": False, "error": "not found"})

    # ── PUT / DELETE ───────────────────────────────────────────────────────

    def do_PUT(self):
        if not check_rate_limit(self):
            self._json(429, {"error": "请求过于频繁，请稍后再试"})
            return
        # 更新任务状态（需管理权限）
        if self.path.startswith("/api/tasks/") and self.path.endswith("/status"):
            user = require_auth(self)
            if not check_permission(user, "manager"):
                self._json(401 if not user else 403, {"ok": False, "error": "需要管理权限"})
                return
            task_id = self.path.replace("/api/tasks/", "").replace("/status", "").split("?")[0]
            data = read_body(self)
            status = str(data.get("status") or "").strip()
            conclusion = str(data.get("conclusion") or "").strip()
            if not status:
                self._json(400, {"ok": False, "error": "status required"})
                return
            update_review_status(task_id, status, conclusion)
            self._json(200, {"ok": True, "taskId": task_id, "status": status})
            return

        # 模板管理 - PUT 更新
        if self.path == "/api/templates" or self.path.startswith("/api/templates?"):
            user = require_auth(self)
            if not check_permission(user, "manager"):
                self._json(401 if not user else 403, {"ok": False, "error": "需要管理员权限"})
                return
            data = read_body(self)
            tpl_id = str(data.get("id") or "").strip()
            if not tpl_id:
                self._json(400, {"ok": False, "error": "id required"})
                return
            self._json(200, update_template(tpl_id, data))
            return

        self._json(404, {"ok": False, "error": "not found"})

    def do_DELETE(self):
        if not check_rate_limit(self):
            self._json(429, {"error": "请求过于频繁，请稍后再试"})
            return
        # 删除任务（需管理员权限）
        if self.path.startswith("/api/tasks/"):
            user = require_auth(self)
            if not is_admin(user):
                self._json(403, {"ok": False, "error": "需要管理员权限"})
                return
            task_id = self.path.replace("/api/tasks/", "").split("?")[0]
            if not task_id:
                self._json(400, {"ok": False, "error": "taskId required"})
                return
            delete_review(task_id)
            self._json(200, {"ok": True, "taskId": task_id, "message": "已删除"})
            return

        # 模板管理 - DELETE 删除
        if self.path == "/api/templates" or self.path.startswith("/api/templates?"):
            user = require_auth(self)
            if not check_permission(user, "manager"):
                self._json(401 if not user else 403, {"ok": False, "error": "需要管理员权限"})
                return
            data = read_body(self)
            tpl_id = str(data.get("id") or "").strip()
            if not tpl_id:
                self._json(400, {"ok": False, "error": "id required"})
                return
            self._json(200, delete_template(tpl_id))
            return

        self._json(404, {"ok": False, "error": "not found"})


# ============================================================================
# 主入口
# ============================================================================

def main() -> None:
    init_users()
    init_db()
    UPLOAD_DIR.mkdir(exist_ok=True)
    TASK_DIR.mkdir(exist_ok=True)
    PROGRESS_DIR.mkdir(exist_ok=True)

    # 启动 WebSocket 直连服务器（后台线程）
    try:
        from ws_server import run_ws_in_thread
        ws_thread = threading.Thread(target=run_ws_in_thread, daemon=True, name="ws-server")
        ws_thread.start()
        time.sleep(0.5)  # 等待 WS 服务器就绪
    except Exception as e:
        log_warn("WebSocket 服务器启动失败: %s", e)

    try:
        subprocess.run([sys.executable, str(BUILD)], cwd=str(UI_DIR), timeout=45)
    except Exception:
        log_warn("build_data.py 执行失败，将使用现有 data.js")
    port = config_getint("server", "http_port", fallback=8788)
    host = config_get("server", "host", fallback="127.0.0.1")
    httpd = ThreadingHTTPServer((host, port), Handler)
    log_info("第一服务研发小组审核系统 v1.1: http://%s:%s/index.html", host, port)
    ws_port = config_getint("server", "ws_port", fallback=8789)
    log_info("WebSocket 直连: ws://%s:%s", host, ws_port)
    log_info("数据库: %s · 日志目录: %s", DB_PATH, LOG_DIR)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
