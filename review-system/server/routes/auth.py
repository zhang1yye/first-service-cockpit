"""审核系统 v2.0 — 认证路由 /api/auth/*"""
import json
from fastapi import APIRouter, Depends, HTTPException, Request

from auth.service import authenticate, destroy_session, load_users
from auth.middleware import require_auth
from models.review import LoginRequest, ChangePasswordRequest

router = APIRouter(prefix="/api/auth", tags=["认证"])


@router.post("/login")
def login(data: LoginRequest):
    result = authenticate(data.username, data.password)
    if not result:
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    return result


@router.get("/me")
def me(user: dict = Depends(require_auth)):
    return {"ok": True, "user": user}


@router.post("/logout")
def logout(request: Request, user: dict = Depends(require_auth)):
    token = request.cookies.get("token") or request.headers.get("Authorization", "").replace("Bearer ", "")
    if token:
        destroy_session(token)
    return {"ok": True, "message": "已登出"}


@router.post("/change-password")
def change_password(data: ChangePasswordRequest, user: dict = Depends(require_auth)):
    if len(data.new_password) < 8:
        raise HTTPException(status_code=400, detail="新密码至少8位")
    users = load_users()
    uname = user["username"]
    uinfo = users.get(uname)
    if not uinfo:
        raise HTTPException(status_code=404, detail="用户不存在")
    from auth.service import _verify_password, _hash_password
    ok, _ = _verify_password(data.old_password, uinfo.get("password_hash", ""))
    if not ok:
        raise HTTPException(status_code=403, detail="旧密码不正确")
    users[uname]["password_hash"] = _hash_password(data.new_password)
    from config import USERS_FILE
    USERS_FILE.write_text(json.dumps(users, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"ok": True, "message": "密码已修改"}
