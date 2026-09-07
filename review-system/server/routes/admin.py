"""审核系统 v2.0 — 管理路由 /api/admin/* + /api/refresh + /health"""
import json
import os
import gzip
import shutil
import subprocess
import re
from datetime import datetime
from pathlib import Path
from fastapi import APIRouter, Depends, HTTPException

from auth.middleware import require_auth, require_role
from auth.service import load_users, _hash_password
from config import USERS_FILE, ROLE_LEVEL, BASE_DIR, DB_PATH

# 备份目录（部署环境硬编码路径）
BACKUP_DIR = Path("/opt/review-system/backups")
# 备份脚本路径
BACKUP_SCRIPT = BASE_DIR / "server" / "scripts" / "backup.sh"
# 备份保留天数
RETENTION_DAYS = 7

router = APIRouter(tags=["系统管理"])


@router.get("/health")
def health():
    return {"status": "ok", "service": "review-system", "version": "2.0"}


@router.get("/api/status")
def system_status(user: dict = Depends(require_auth)):
    from database import query_one, query
    total = query_one("SELECT COUNT(*) as cnt FROM reviews")
    pending = query_one("SELECT COUNT(*) as cnt FROM reviews WHERE status IN ('pending','running')")
    completed = query_one("SELECT COUNT(*) as cnt FROM reviews WHERE status='completed'")
    failed = query_one("SELECT COUNT(*) as cnt FROM reviews WHERE status='failed'")
    recent = query("SELECT task_id,title,status,created_at FROM reviews ORDER BY id DESC LIMIT 5")
    # 平均审核时间（最近30天完成的任务）
    avg_time_row = query_one(
        "SELECT ROUND(AVG((julianday(updated_at)-julianday(created_at))*86400)) as avg_sec FROM reviews WHERE status='completed' AND updated_at > datetime('now','-30 days')"
    )
    avg_sec = avg_time_row["avg_sec"] if avg_time_row and avg_time_row["avg_sec"] else 0
    avg_min = round(avg_sec / 60, 1) if avg_sec else 0
    # 成功率
    completed_cnt = completed["cnt"] if completed else 0
    failed_cnt = failed["cnt"] if failed else 0
    denom = completed_cnt + failed_cnt
    success_rate = round(completed_cnt / denom * 100, 1) if denom > 0 else 100
    # 在线 bot 数
    from services.ai_engine import PROFILES_8
    return {
        "ok": True,
        "online": len(PROFILES_8),
        "totalTasks": total["cnt"] if total else 0,
        "pending_tasks": pending["cnt"] if pending else 0,
        "pending": pending["cnt"] if pending else 0,
        "completed": completed_cnt,
        "total_completed": completed_cnt,
        "avg_time": f"{avg_min}分钟",
        "success_rate": success_rate,
        "risks": failed_cnt,
        "pendingTasks": pending["cnt"] if pending else 0,
        "recentTasks": [dict(r) for r in recent],
    }


@router.get("/api/admin/users")
def list_users(user: dict = Depends(require_role("admin"))):
    users = load_users()
    result = []
    for uname, info in users.items():
        result.append({
            "username": uname,
            "display_name": info.get("display_name", ""),
            "role": info.get("role", "viewer"),
            "created_at": info.get("created_at", ""),
        })
    return {"ok": True, "users": result}


@router.post("/api/admin/users/add")
def add_user(data: dict, user: dict = Depends(require_role("admin"))):
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", "")).strip()
    role = str(data.get("role", "reviewer")).strip()
    display_name = str(data.get("display_name", "")).strip()
    if not username or not password:
        raise HTTPException(status_code=400, detail="用户名和密码不能为空")
    if role not in ROLE_LEVEL:
        raise HTTPException(status_code=400, detail=f"无效角色: {role}")
    users = load_users()
    users[username] = {
        "password_hash": _hash_password(password),
        "display_name": display_name or username,
        "role": role,
        "created_at": users.get(username, {}).get("created_at", datetime.now().strftime("%Y-%m-%d")),
    }
    USERS_FILE.write_text(json.dumps(users, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "message": f"用户 {username} 已更新"}


@router.post("/api/admin/users/delete")
def delete_user(data: dict, user: dict = Depends(require_role("admin"))):
    username = str(data.get("username", "")).strip()
    if not username:
        raise HTTPException(status_code=400, detail="用户名不能为空")
    if username == "admin":
        raise HTTPException(status_code=403, detail="不能删除 admin 用户")
    users = load_users()
    if username in users:
        del users[username]
        USERS_FILE.write_text(json.dumps(users, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "message": f"用户 {username} 已删除"}


@router.post("/api/refresh")
def refresh_data(user: dict = Depends(require_role("admin"))):
    """刷新 data.js（调用 build_data.py）"""
    import subprocess
    from config import UI_DIR
    build_script = UI_DIR / "scripts" / "build_data.py"
    if build_script.exists():
        subprocess.run(["python3", str(build_script)], capture_output=True, timeout=30)
    return {"ok": True, "message": "数据已刷新"}


# ============================================================
# 备份管理端点
# ============================================================

def _parse_backup_timestamp(filename: str) -> str:
    """从备份文件名中提取时间戳，格式: YYYYMMDD_HHMMSS"""
    match = re.search(r"reviews_backup_(\d{8}_\d{6})", filename)
    return match.group(1) if match else ""


def _validate_backup_filename(filename: str) -> bool:
    """
    白名单校验备份文件名。
    只允许 reviews_backup_YYYYMMDD_HHMMSS.db.gz 格式，
    拒绝路径穿越字符（/、..）和任何不符合模式的文件名。
    """
    if not filename:
        return False
    # 拒绝路径穿越
    if "/" in filename or ".." in filename:
        return False
    # 白名单模式：reviews_backup_8位数字_6位数字.db.gz
    pattern = r"^reviews_backup_\d{8}_\d{6}\.db\.gz$"
    return bool(re.match(pattern, filename))


@router.get("/api/admin/backups")
def list_backups(user: dict = Depends(require_role("admin"))):
    """列出所有备份文件，按修改时间倒序"""
    backups = []
    if BACKUP_DIR.exists():
        for f in sorted(BACKUP_DIR.glob("reviews_backup_*.db.gz"), key=lambda x: x.stat().st_mtime, reverse=True):
            stat = f.stat()
            size_mb = round(stat.st_size / (1024 * 1024), 2)
            backups.append({
                "filename": f.name,
                "size": stat.st_size,
                "size_mb": size_mb,
                "modified_at": datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
                "timestamp": _parse_backup_timestamp(f.name),
            })
    return {
        "ok": True,
        "backups": backups,
        "total": len(backups),
        "retention_days": RETENTION_DAYS,
    }


@router.post("/api/admin/backups/trigger")
def trigger_backup(user: dict = Depends(require_role("admin"))):
    """手动触发备份（执行 backup.sh 脚本）"""
    if not BACKUP_SCRIPT.exists():
        raise HTTPException(status_code=500, detail=f"备份脚本不存在: {BACKUP_SCRIPT}")

    try:
        result = subprocess.run(
            ["/bin/bash", str(BACKUP_SCRIPT)],
            capture_output=True,
            text=True,
            timeout=120,
            env={
                **os.environ,
                # 开发环境：指向当前项目数据库
                "DB_PATH": str(DB_PATH),
                "BACKUP_DIR": str(BACKUP_DIR),
            },
        )
        output = result.stdout.strip()
        if result.returncode != 0:
            error_msg = result.stderr.strip() or output or "脚本执行失败"
            raise HTTPException(status_code=500, detail=f"备份失败: {error_msg}")

        # 从输出中提取备份文件名
        filename = ""
        for line in output.split("\n"):
            if "备份完成:" in line and ".db.gz" in line:
                filename = line.split("备份完成:")[-1].strip()
                break

        return {
            "ok": True,
            "message": "备份已触发",
            "output": output[-2000:],  # 截断过长输出
            "filename": filename,
        }
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=500, detail="备份脚本执行超时（120秒）")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"备份执行异常: {str(e)}")


@router.post("/api/admin/backups/restore")
def restore_backup(data: dict, user: dict = Depends(require_role("admin"))):
    """
    从指定备份文件恢复数据库。

    请求体: {"filename": "reviews_backup_20260525_020001.db.gz"}
    """
    filename = str(data.get("filename", "")).strip()

    # 白名单校验：拒绝不安全的文件名
    if not _validate_backup_filename(filename):
        raise HTTPException(
            status_code=400,
            detail="无效的备份文件名。只允许 reviews_backup_YYYYMMDD_HHMMSS.db.gz 格式",
        )

    # 检查备份文件是否存在
    backup_path = BACKUP_DIR / filename
    if not backup_path.exists():
        raise HTTPException(status_code=404, detail=f"备份文件不存在: {filename}")

    try:
        # 步骤 1: 解压备份文件到临时位置
        decompressed_path = BACKUP_DIR / f"_restore_temp_{filename.replace('.gz', '')}"
        with gzip.open(backup_path, "rb") as gz_in:
            with open(decompressed_path, "wb") as db_out:
                shutil.copyfileobj(gz_in, db_out)

        # 步骤 2: 恢复前创建紧急备份（当前数据库的快照）
        pre_restore_timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        pre_restore_name = f"reviews_pre_restore_{pre_restore_timestamp}.db.gz"
        pre_restore_path = BACKUP_DIR / pre_restore_name

        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        if DB_PATH.exists():
            with open(DB_PATH, "rb") as db_in:
                with gzip.open(pre_restore_path, "wb") as gz_out:
                    shutil.copyfileobj(db_in, gz_out)

        # 步骤 3: 关闭当前连接
        try:
            from database import close_db
            close_db()
        except Exception:
            pass  # 连接关闭失败不阻止恢复

        # 步骤 4: 替换数据库文件
        shutil.copy2(str(decompressed_path), str(DB_PATH))

        # 步骤 5: 清理临时文件
        try:
            os.remove(decompressed_path)
        except OSError:
            pass

        # 步骤 6: 尝试触发数据刷新（build_data.py）
        refresh_error = None
        try:
            from config import UI_DIR
            build_script = UI_DIR / "scripts" / "build_data.py"
            if build_script.exists():
                subprocess.run(
                    ["python3", str(build_script)],
                    capture_output=True,
                    timeout=30,
                )
        except Exception as e:
            refresh_error = str(e)

        return {
            "ok": True,
            "message": f"数据库已从 {filename} 恢复，请重启服务",
            "pre_restore_backup": pre_restore_name,
            "restart_required": True,
            "refresh_error": refresh_error,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"恢复失败: {str(e)}")
