"""Auth routes: register, login, me, change-password."""
from datetime import datetime, timezone
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import EmailStr

from auth import (
    create_token, get_current_user, hash_password, verify_password,
)
from db import users_col
from models import PasswordChange, TokenResponse, UserLogin, UserOut, UserRegister

router = APIRouter(prefix="/auth", tags=["auth"])


async def _user_to_public(u: dict) -> dict:
    return {
        "id": u["id"], "email": u["email"], "name": u.get("name", ""),
        "role": u.get("role", "user"),
        "created_at": u.get("created_at") or datetime.now(timezone.utc).isoformat(),
    }


def _password_complexity_error(pw: str) -> str | None:
    """Return error message when password lacks the required mix, else None.
    Required: ≥1 letter AND ≥1 digit-or-symbol. Length is enforced by the
    pydantic model (min 8, max 72)."""
    has_letter = any(c.isalpha() for c in pw)
    has_other = any(not c.isalpha() for c in pw)
    if not (has_letter and has_other):
        return "Password must contain at least one letter and one digit or symbol"
    return None


@router.post("/register", response_model=TokenResponse)
async def register(body: UserRegister):
    err = _password_complexity_error(body.password)
    if err:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, err)
    existing = await users_col.find_one({"email": body.email.lower()})
    if existing:
        raise HTTPException(status.HTTP_409_CONFLICT, "Email already registered")
    doc = {
        "id": str(uuid.uuid4()),
        "email": body.email.lower(),
        "name": (body.name or body.email.split("@")[0]).strip(),
        "role": "user",
        "password_hash": hash_password(body.password),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await users_col.insert_one(doc)
    token = create_token(doc["id"], doc["role"])
    return {"access_token": token, "token_type": "bearer", "user": await _user_to_public(doc)}


@router.post("/login", response_model=TokenResponse)
async def login(body: UserLogin):
    user = await users_col.find_one({"email": body.email.lower()})
    if not user or not verify_password(body.password, user.get("password_hash", "")):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid credentials")
    token = create_token(user["id"], user.get("role", "user"))
    return {"access_token": token, "token_type": "bearer", "user": await _user_to_public(user)}


@router.get("/me", response_model=UserOut)
async def me(user: dict = Depends(get_current_user)):
    return await _user_to_public(user)


@router.post("/change-password")
async def change_password(body: PasswordChange, user: dict = Depends(get_current_user)):
    err = _password_complexity_error(body.new_password)
    if err:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, err)
    db_user = await users_col.find_one({"id": user["id"]})
    if not db_user or not verify_password(body.current_password, db_user.get("password_hash", "")):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Current password is incorrect")
    await users_col.update_one(
        {"id": user["id"]},
        {"$set": {"password_hash": hash_password(body.new_password)}},
    )
    return {"ok": True}
