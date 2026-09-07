"""审核系统 v2.0 — 认证服务"""
import hashlib
import json
import os
import secrets
import threading
import time
from pathlib import Path

from config import USERS_FILE, SESSION_FILE, SESSION_TTL, ROLE_LEVEL

SESSIONS: dict = {}  # token -> user_info
SESSION_LOCK = threading.Lock()


def _hash_password(password: str) -> str:
    salt = os.urandom(16)
    h = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 100000)
    return f"pbkdf2$100000${salt.hex()}${h.hex()}"


# 默认用户（PBKDF2 加密，仅 fallback）
DEFAULT_USERS = {
    "admin": {
        "password_hash": _hash_password("admin888"),
        "display_name": "系统管理员", "role": "admin", "created_at": "2026-01-01",
    },
    "zhangye": {
        "password_hash": _hash_password("review2026"),
        "display_name": "张野", "role": "admin", "created_at": "2026-01-01",
    },
    "manager": {
        "password_hash": _hash_password("manager2026"),
        "display_name": "审核经理", "role": "manager", "created_at": "2026-01-01",
    },
    "reviewer": {
        "password_hash": _hash_password("review123"),
        "display_name": "审核员", "role": "reviewer", "created_at": "2026-01-01",
    },
    "viewer": {
        "password_hash": _hash_password("view2026"),
        "display_name": "访客", "role": "viewer", "created_at": "2026-01-01",
    },
}

def _verify_password(password: str, stored: str) -> tuple[bool, str | None]:
    """验证密码，返回 (是否通过, 升级后的哈希或None)。自动升级旧 SHA-256 格式。"""
    if stored.startswith("pbkdf2$"):
        try:
            _, iters, salt_hex, hash_hex = stored.split("$")
            salt = bytes.fromhex(salt_hex)
            expected = bytes.fromhex(hash_hex)
            actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, int(iters))
            return (actual == expected), None
        except Exception:
            return False, None
    # 旧版 SHA-256（无盐）— 通过但标记需要升级
    if hashlib.sha256(password.encode()).hexdigest() == stored:
        return True, _hash_password(password)
    return False, None


def load_users() -> dict:
    try:
        return json.loads(USERS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return dict(DEFAULT_USERS)


def authenticate(username: str, password: str) -> dict | None:
    """验证用户登录，返回 {ok, token, user} 或 None"""
    users = load_users()
    user = users.get(username)
    if not user:
        return None
    ok, new_hash = _verify_password(password, user.get("password_hash", ""))
    if not ok:
        return None
    if new_hash:
        user["password_hash"] = new_hash
        try:
            USERS_FILE.write_text(json.dumps(users, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass
    token = secrets.token_hex(32)
    user_info = {"username": username, "display_name": user["display_name"], "role": user["role"]}
    with SESSION_LOCK:
        now_ts = time.time()
        expired = [t for t, s in SESSIONS.items() if now_ts - s.get("login_at", 0) > SESSION_TTL]
        for t in expired:
            del SESSIONS[t]
        SESSIONS[token] = {**user_info, "login_at": now_ts}
        _save_sessions()
    return {"ok": True, "token": token, "user": user_info}


def get_session(token: str) -> dict | None:
    """获取会话信息（滑动 TTL）"""
    with SESSION_LOCK:
        sess = SESSIONS.get(token)
        if not sess:
            return None
        now_ts = time.time()
        if now_ts - sess.get("login_at", 0) > SESSION_TTL:
            del SESSIONS[token]
            _save_sessions()
            return None
        sess["login_at"] = now_ts
        return {k: v for k, v in sess.items() if k != "login_at"}


def destroy_session(token: str):
    with SESSION_LOCK:
        if token in SESSIONS:
            del SESSIONS[token]
            _save_sessions()


def check_permission(user: dict | None, min_role: str = "viewer") -> bool:
    if not user:
        return False
    return ROLE_LEVEL.get(user.get("role", "viewer"), 0) >= ROLE_LEVEL.get(min_role, 0)


def _load_sessions():
    if SESSION_FILE.exists():
        try:
            data = json.loads(SESSION_FILE.read_text(encoding="utf-8"))
            now_ts = time.time()
            for k, v in data.items():
                if now_ts - v.get("login_at", 0) < SESSION_TTL:
                    SESSIONS[k] = v
        except Exception:
            pass


def _save_sessions():
    try:
        SESSION_FILE.write_text(json.dumps(SESSIONS, ensure_ascii=False), encoding="utf-8")
        os.chmod(SESSION_FILE, 0o600)
    except Exception:
        pass


# 启动时恢复会话
_load_sessions()
