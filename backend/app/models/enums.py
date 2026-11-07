from enum import StrEnum


class RoleName(StrEnum):
    VISITOR = "visitor"
    BUYER = "buyer"
    SELLER = "seller"
    DRIVER = "driver"
    ADMIN = "admin"


class RoleStatus(StrEnum):
    ACTIVE = "active"
    PENDING = "pending"  # awaiting administrator review (seller, driver)
    REJECTED = "rejected"
    REVOKED = "revoked"


class ContactChannel(StrEnum):
    EMAIL = "email"
    PHONE = "phone"


class Language(StrEnum):
    EN = "en"
    KM = "km"


# Roles a user may request for themselves, and whether an administrator must approve them.
SELF_SERVICE_ROLES: dict[RoleName, bool] = {
    RoleName.VISITOR: False,
    RoleName.BUYER: False,
    RoleName.SELLER: True,
    RoleName.DRIVER: True,
}
