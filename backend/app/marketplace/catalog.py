"""Storefronts and the product catalogue (products belong to the merchant; every storefront of
a merchant shows the same catalogue), stock, images, and the regulated-category policy."""

from __future__ import annotations

import uuid

from fastapi import UploadFile, status
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError, conflict, not_found
from app.marketplace import media
from app.marketplace.merchants import require_merchant
from app.models import CartItem, Inventory, Merchant, Product, ProductCategory, Shop, User
from app.schemas.market import (
    AdminProductOut,
    CategoryOut,
    ProductIn,
    ProductOut,
    ProductPatch,
    ShopDetailOut,
    ShopIn,
    ShopOut,
    ShopUnitWorld,
)
from app.services import audit

MAX_PRODUCTS = 200
PURCHASABLE = "active"


def image_url(name: str | None) -> str | None:
    return f"/api/v1/media/products/{name}" if name else None


def product_out(p: Product) -> ProductOut:
    stock = p.inventory.on_hand if p.inventory else 0
    return ProductOut(
        id=p.id,
        merchant_id=p.merchant_id,
        name=p.name,
        name_km=p.name_km,
        description=p.description,
        category=p.category.slug,
        category_name=p.category.name,
        min_age=p.category.min_age,
        price_minor=p.price_minor,
        currency=p.currency,
        image_url=image_url(p.image_name),
        model=p.model,
        status=p.status,
        review_note=p.review_note,
        fulfillment=list(p.fulfillment),
        stock=stock,
        in_stock=stock > 0,
        sort_order=p.sort_order,
    )


async def _owner_username(session: AsyncSession, merchant: Merchant) -> str:
    return await session.scalar(select(User.username).where(User.id == merchant.owner_id)) or ""


async def _catalog_versions(
    session: AsyncSession, merchant_ids: list[uuid.UUID]
) -> dict[uuid.UUID, str]:
    if not merchant_ids:
        return {}
    rows = await session.execute(
        select(
            Product.merchant_id,
            func.count(Product.id),
            func.max(func.greatest(Product.updated_at, Inventory.updated_at)),
        )
        .outerjoin(Inventory, Inventory.product_id == Product.id)
        .where(Product.merchant_id.in_(merchant_ids))
        .group_by(Product.merchant_id)
    )
    return {m: f"{n}:{(t.timestamp() if t else 0):.3f}" for m, n, t in rows.all()}


async def shop_out(session: AsyncSession, shop: Shop, version: str = "") -> ShopOut:
    unit = shop.unit
    merchant = shop.merchant
    return ShopOut(
        id=shop.id,
        name=shop.name,
        name_km=shop.name_km,
        tagline=shop.tagline,
        theme=shop.theme,
        primary_color=shop.primary_color,
        accent_color=shop.accent_color,
        is_open=shop.is_open and merchant.status == "approved",
        status=shop.status,
        merchant_id=merchant.id,
        merchant_name=merchant.business_name,
        owner_username=await _owner_username(session, merchant),
        category=merchant.category,
        unit=ShopUnitWorld(
            code=unit.code,
            corners=unit.corners,
            door_x=unit.door_x,
            door_z=unit.door_z,
            heading=unit.heading,
            width_m=unit.width_m,
            depth_m=unit.depth_m,
            ceiling_m=unit.ceiling_m,
            street_name=unit.street_name,
        ),
        operating_hours=merchant.operating_hours,
        catalog_version=version,
    )


async def world_shops(session: AsyncSession, region_id: uuid.UUID | None = None) -> list[ShopOut]:
    """Every live storefront (approved merchant, active shop) for the 3D city."""
    stmt = (
        select(Shop)
        .join(Merchant, Merchant.id == Shop.merchant_id)
        .where(Shop.status == "active", Merchant.status == "approved")
        .order_by(Shop.created_at)
    )
    shops = (await session.scalars(stmt)).unique().all()
    if region_id is not None:
        shops = [s for s in shops if s.unit.region_id == region_id]
    versions = await _catalog_versions(session, list({s.merchant_id for s in shops}))
    return [await shop_out(session, s, versions.get(s.merchant_id, "0")) for s in shops]


async def visible_products(session: AsyncSession, merchant_id: uuid.UUID) -> list[Product]:
    return list(
        (
            await session.scalars(
                select(Product)
                .where(Product.merchant_id == merchant_id, Product.status == PURCHASABLE)
                .order_by(Product.sort_order, Product.name)
            )
        )
        .unique()
        .all()
    )


async def shop_detail(session: AsyncSession, shop_id: uuid.UUID) -> ShopDetailOut:
    shop = await session.get(Shop, shop_id)
    if shop is None or shop.status != "active" or shop.merchant.status != "approved":
        raise not_found("Shop")
    versions = await _catalog_versions(session, [shop.merchant_id])
    base = await shop_out(session, shop, versions.get(shop.merchant_id, "0"))
    products = await visible_products(session, shop.merchant_id)
    return ShopDetailOut(**base.model_dump(), products=[product_out(p) for p in products])


async def my_shops(session: AsyncSession, user: User) -> list[ShopOut]:
    merchant = await require_merchant(session, user)
    shops = (
        await session.scalars(
            select(Shop).where(Shop.merchant_id == merchant.id, Shop.status == "active")
        )
    ).unique().all()
    return [await shop_out(session, s) for s in shops]


async def update_shop(session: AsyncSession, user: User, shop_id: uuid.UUID, data: ShopIn) -> Shop:
    merchant = await require_merchant(session, user)
    shop = await session.get(Shop, shop_id, with_for_update=True)
    if shop is None or shop.merchant_id != merchant.id or shop.status != "active":
        raise not_found("Shop")
    if merchant.status != "approved" and data.is_open:
        raise AppError(status.HTTP_403_FORBIDDEN, "NOT_ELIGIBLE", "Your merchant is not approved.")
    for key, value in data.model_dump(exclude_unset=True).items():
        if value is not None or key in ("name_km", "tagline"):
            setattr(shop, key, value)
    await session.commit()
    from app.multiplayer.hub import hub

    await hub.shops_changed()
    return shop


# ── categories and products ──────────────────────────────────────────────────────────


async def categories(session: AsyncSession) -> list[CategoryOut]:
    rows = await session.scalars(select(ProductCategory).order_by(ProductCategory.sort_order))
    return [CategoryOut.model_validate(c) for c in rows.all()]


async def _category(session: AsyncSession, slug: str) -> ProductCategory:
    category = await session.scalar(select(ProductCategory).where(ProductCategory.slug == slug))
    if category is None:
        raise AppError(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "UNKNOWN_CATEGORY", "Choose a listed category."
        )
    if category.policy == "prohibited":
        raise AppError(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "PROHIBITED_CATEGORY",
            f"{category.name} cannot be sold here. {category.policy_note or ''}".strip(),
        )
    return category


async def _own_product(session: AsyncSession, user: User, product_id: uuid.UUID) -> Product:
    merchant = await require_merchant(session, user)
    product = await session.get(Product, product_id, with_for_update=True)
    if product is None or product.merchant_id != merchant.id or product.status == "archived":
        raise not_found("Product")
    if merchant.status == "suspended":
        raise AppError(status.HTTP_403_FORBIDDEN, "SUSPENDED", "This merchant is suspended.")
    return product


async def my_products(session: AsyncSession, user: User) -> list[ProductOut]:
    merchant = await require_merchant(session, user)
    rows = await session.scalars(
        select(Product)
        .where(Product.merchant_id == merchant.id, Product.status != "archived")
        .order_by(Product.sort_order, Product.created_at)
    )
    return [product_out(p) for p in rows.unique().all()]


async def create_product(session: AsyncSession, user: User, data: ProductIn, ip: str) -> Product:
    merchant = await require_merchant(session, user, lock=True)
    if merchant.status in ("rejected", "suspended"):
        raise AppError(
            status.HTTP_403_FORBIDDEN, "NOT_ELIGIBLE", f"This merchant is {merchant.status}."
        )
    count = await session.scalar(
        select(func.count())
        .select_from(Product)
        .where(Product.merchant_id == merchant.id, Product.status != "archived")
    )
    if (count or 0) >= MAX_PRODUCTS:
        raise conflict("PRODUCT_LIMIT", f"Up to {MAX_PRODUCTS} products per merchant.")
    category = await _category(session, data.category)
    product = Product(
        merchant_id=merchant.id,
        category_id=category.id,
        name=data.name,
        name_km=data.name_km,
        description=data.description,
        price_minor=data.price_minor,
        model=data.model,
        fulfillment=data.fulfillment,
        # Restricted categories (alcohol) are listed only after an administrator's review.
        status="pending_review"
        if category.policy == "restricted"
        else ("active" if data.visible else "hidden"),
        sort_order=int(count or 0),
    )
    session.add(product)
    await session.flush()
    session.add(Inventory(product_id=product.id, on_hand=data.stock))
    audit.record(
        session,
        "product.created",
        actor=user.id,
        target_type="product",
        target_id=product.id,
        ip=ip,
        price_minor=data.price_minor,
        category=category.slug,
    )
    await session.commit()
    return await reload(session, product.id)


async def reload(session: AsyncSession, product_id: uuid.UUID) -> Product:
    product = await session.scalar(
        select(Product).where(Product.id == product_id).execution_options(populate_existing=True)
    )
    assert product is not None
    return product


async def update_product(
    session: AsyncSession, user: User, product_id: uuid.UUID, data: ProductPatch, ip: str
) -> Product:
    product = await _own_product(session, user, product_id)
    changes = data.model_dump(exclude_unset=True)
    needs_review = False
    if "category" in changes and changes["category"]:
        category = await _category(session, changes.pop("category"))
        if category.id != product.category_id:
            product.category_id = category.id
            needs_review = category.policy == "restricted"
    restricted = product.category.policy == "restricted" if not needs_review else True
    if restricted and any(k in changes for k in ("name", "description", "name_km")):
        needs_review = True  # a reviewed listing's text changed: review it again
    visible = changes.pop("visible", None)
    old_price = product.price_minor
    for key, value in changes.items():
        if value is not None or key in ("name_km", "description"):
            setattr(product, key, value)
    if needs_review:
        product.status, product.review_note = "pending_review", None
    elif visible is not None and product.status in ("active", "hidden"):
        product.status = "active" if visible else "hidden"
    if product.price_minor != old_price:
        audit.record(
            session,
            "product.price_changed",
            actor=user.id,
            target_type="product",
            target_id=product.id,
            ip=ip,
            old=old_price,
            new=product.price_minor,
        )
    await session.commit()
    return await reload(session, product.id)


async def set_stock(session: AsyncSession, user: User, product_id: uuid.UUID, on_hand: int) -> Product:
    product = await _own_product(session, user, product_id)
    inventory = await session.get(Inventory, product.id, with_for_update=True)
    if inventory is None:
        session.add(Inventory(product_id=product.id, on_hand=on_hand))
    else:
        inventory.on_hand = on_hand
    await session.commit()
    return await reload(session, product.id)


async def set_image(
    session: AsyncSession, user: User, product_id: uuid.UUID, upload: UploadFile
) -> Product:
    product = await _own_product(session, user, product_id)
    name = await media.save_product_image(upload)
    old, product.image_name = product.image_name, name
    await session.commit()
    media.delete_product_image(old)
    return await reload(session, product.id)


async def archive_product(session: AsyncSession, user: User, product_id: uuid.UUID, ip: str) -> None:
    """Products are archived, not deleted, so past orders keep their history."""
    product = await _own_product(session, user, product_id)
    product.status = "archived"
    await session.execute(delete(CartItem).where(CartItem.product_id == product.id))
    audit.record(
        session, "product.archived", actor=user.id, target_type="product", target_id=product.id, ip=ip
    )
    await session.commit()


# ── administration (restricted categories) ───────────────────────────────────────────


async def admin_products(session: AsyncSession, status_filter: str) -> list[AdminProductOut]:
    rows = (
        await session.execute(
            select(Product, Merchant.business_name)
            .join(Merchant, Merchant.id == Product.merchant_id)
            .where(Product.status == status_filter)
            .order_by(Product.updated_at)
            .limit(100)
        )
    ).unique().all()
    return [
        AdminProductOut(**product_out(p).model_dump(), merchant_name=name) for p, name in rows
    ]


async def admin_review_product(
    session: AsyncSession, admin: User, product_id: uuid.UUID, approve: bool, note: str | None, ip: str
) -> Product:
    product = await session.get(Product, product_id, with_for_update=True)
    if product is None:
        raise not_found("Product")
    if product.status != "pending_review":
        raise conflict("ALREADY_DECIDED", f"This product is {product.status}.")
    product.status = "active" if approve else "rejected"
    product.review_note = note
    audit.record(
        session,
        "product.approved" if approve else "product.rejected",
        actor=admin.id,
        target_type="product",
        target_id=product.id,
        ip=ip,
        note=note,
    )
    await session.commit()
    return await reload(session, product.id)
