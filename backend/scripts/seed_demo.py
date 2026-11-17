"""Idempotent local demo storefront. Never runs in production or creates online players."""

import asyncio
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select

from app.core.config import settings
from app.core.database import SessionLocal, engine
from app.core.security import hash_password
from app.marketplace import catalog, claims, merchants
from app.models import (
    Merchant,
    Product,
    PropertyClaim,
    RoleName,
    RoleStatus,
    Shop,
    User,
    UserProfile,
    UserRole,
    VirtualProperty,
)
from app.schemas.market import ClaimIn, MerchantIn, ProductIn, ShopIn
from app.utils.time import utcnow


async def main() -> None:
    if settings.app_env == "production":
        raise SystemExit("Demo seeding is only available outside production.")
    async with SessionLocal() as session:
        admin = await session.scalar(
            select(User).where(
                User.roles.any((UserRole.role == "admin") & (UserRole.status == "active"))
            )
        )
        if not admin:
            raise SystemExit("Run scripts/seed.py first.")
        user = await session.scalar(select(User).where(User.username == "demo_market"))
        if not user:
            password = secrets.token_urlsafe(18)
            now = utcnow()
            user = User(
                username="demo_market",
                email="demo_market@ppw.local",
                password_hash=hash_password(password),
                email_verified_at=now,
                terms_version=settings.terms_version,
                terms_accepted_at=now,
                privacy_accepted_at=now,
            )
            user.profile = UserProfile(
                display_name="Demo market", preferred_language="en", world_visible=False
            )
            user.roles = [
                UserRole(
                    role=RoleName.VISITOR,
                    status=RoleStatus.ACTIVE,
                    requested_at=now,
                    decided_at=now,
                )
            ]
            session.add(user)
            await session.commit()
            print(f"Demo seller: demo_market\nGenerated password (shown once): {password}")
        merchant = await session.scalar(select(Merchant).where(Merchant.owner_id == user.id))
        if not merchant:
            merchant = await merchants.apply(
                session,
                user,
                MerchantIn(
                    business_name="Daun Penh Demo Market",
                    category="food_drink",
                    contact_email="demo_market@ppw.local",
                    description="Local demonstration shop. All purchases and delivery jobs are simulated.",
                ),
                "local-seed",
            )
            await merchants.decide(
                session, admin, merchant.id, "approve", "Local demo setup", "local-seed"
            )
        elif merchant.status != "approved":
            raise SystemExit("Existing demo merchant is not approved; review it in /admin.")
        # Re-read roles after the approval, without changing any existing account's password.
        await session.refresh(user, ["roles"])
        shop = await session.scalar(
            select(Shop).where(Shop.merchant_id == merchant.id, Shop.status == "active")
        )
        if not shop:
            unit = await session.scalar(
                select(VirtualProperty)
                .where(
                    VirtualProperty.is_active,
                    ~VirtualProperty.requires_verification,
                    ~select(PropertyClaim.id)
                    .where(
                        PropertyClaim.property_id == VirtualProperty.id,
                        PropertyClaim.status.in_(["pending", "approved"]),
                    )
                    .exists(),
                )
                .order_by(
                    VirtualProperty.door_x * VirtualProperty.door_x
                    + VirtualProperty.door_z * VirtualProperty.door_z
                )
                .limit(1)
            )
            if not unit:
                raise SystemExit("No unclaimed demo unit is available.")
            claim = await claims.claim_unit(
                session, user, ClaimIn(unit_code=unit.code), "local-seed"
            )
            shop = await session.scalar(select(Shop).where(Shop.claim_id == claim.id))
            await catalog.update_shop(
                session,
                user,
                shop.id,
                ShopIn(
                    name="Daun Penh Demo Market",
                    tagline="Try shopping & virtual delivery",
                    theme="cafe",
                ),
            )
        existing = set(
            (
                await session.scalars(
                    select(Product.name).where(Product.merchant_id == merchant.id)
                )
            ).all()
        )
        for name, price, model, category in [
            ("Demo kuy teav", 250, "noodles", "food"),
            ("Demo iced coffee", 150, "coffee", "drinks"),
            ("Demo Khmer phrasebook", 899, "book", "books"),
        ]:
            if name not in existing:
                await catalog.create_product(
                    session,
                    user,
                    ProductIn(
                        name=name,
                        price_minor=price,
                        model=model,
                        category=category,
                        stock=100,
                        fulfillment=["pickup", "delivery"],
                    ),
                    "local-seed",
                )
        print(f"Demo storefront ready: {shop.name}. Find it under Places → Shops.")
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
