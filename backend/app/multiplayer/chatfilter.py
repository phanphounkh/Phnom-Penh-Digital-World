"""Chat text hygiene: normalisation, length limits and basic profanity masking.

This is a first line of defence only. The word list is short and English-centric, and masking
is word-based (it does not catch creative spellings or Khmer slurs). Reporting and moderator
review remain the real safety net.
"""

import re
import unicodedata

from app.multiplayer.protocol import CHAT_MAX_CHARS

# Deliberately small; extend from moderation experience (and with Khmer terms, with native help).
BLOCKED_WORDS = {
    "fuck",
    "fucking",
    "shit",
    "bitch",
    "cunt",
    "asshole",
    "bastard",
    "dick",
    "pussy",
    "nigger",
    "nigga",
    "faggot",
    "retard",
    "whore",
    "slut",
}
_WORD = re.compile(r"[A-Za-z]+")
_CONTROL = {"Cc", "Cf", "Co", "Cs"}
ZWSP = "\u200b"


def clean(text: str) -> str:
    """Remove control/format characters (keeps Khmer combining marks), collapse whitespace."""
    kept = "".join(
        ch
        for ch in unicodedata.normalize("NFC", text)
        if unicodedata.category(ch) not in _CONTROL
        or ch == ZWSP  # zero-width space is used in Khmer line breaking
    )
    return " ".join(kept.split())[:CHAT_MAX_CHARS]


def mask(text: str) -> tuple[str, bool]:
    """Replace blocked words with asterisks. Returns (text, was_flagged)."""
    flagged = False

    def sub(match: re.Match[str]) -> str:
        nonlocal flagged
        word = match.group(0)
        if word.lower() in BLOCKED_WORDS:
            flagged = True
            return word[0] + "*" * (len(word) - 1)
        return word

    return _WORD.sub(sub, text), flagged


def prepare(text: str) -> tuple[str, bool]:
    """clean() then mask(). Empty result means the message should be rejected."""
    return mask(clean(text))
