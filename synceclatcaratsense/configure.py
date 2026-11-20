"""
Eclat / CaratSense — SETTINGS (step 2)

Asks for the connection details and writes eclat_config.bat.

Written in Python rather than batch for one specific reason: cmd's `set /p`
performs FILENAME COMPLETION on a Tab character. A tab inside a pasted value —
which is easy to produce copying from a table or a chat window — silently
inserts a filename from the current folder into the middle of the answer. That
happened on a live install: an R2 key came out as
"1_discover.bat4155a8a1f5f56dbf15abeb11f2bc7e0a", the settings saved without
complaint, and the fault would only have surfaced hours later as an
authentication error during the photo upload. `input()` does no such thing.

Every value is also checked for shape before it is written, and shown back for
confirmation, because a typo caught here costs seconds and one caught later
costs an afternoon.
"""
import os
import re
import sys
from getpass import getpass

from gati_target_safety import (
    TargetSafetyError,
    normalize_backend_origin,
    normalize_website_endpoint,
    normalize_website_origin,
)

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "eclat_config.bat")
BACKUP = os.path.join(HERE, "eclat_config.backup.bat")

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def ask(label, default="", secret=False, validate=None, hint=""):
    """Prompt until the answer passes `validate`. Enter keeps `default`."""
    shown = f" [{default}]" if default else ""
    while True:
        raw = getpass(f"  {label}{shown}: ") if secret else input(f"  {label}{shown}: ")
        # A tab or newline pasted into the middle of a value is invisible on
        # screen but corrupts the setting; strip the lot.
        value = raw.replace("\t", "").replace("\r", "").replace("\n", "").strip()
        # Quotes are the other common paste artefact — the config file adds its
        # own, so a pasted pair would end up inside the value.
        value = value.strip('"').strip("'").strip()
        if not value:
            value = default
        if validate:
            problem = validate(value)
            if problem:
                print(f"      ^ {problem}")
                if hint:
                    print(f"        {hint}")
                continue
        return value


def optional(_v):
    return None


def batch_safe(v):
    """Reject bytes that cmd.exe would expand or that break `set "K=V"`."""
    if any(char in v for char in ('"', "%", "\x00")):
        return 'cannot contain a double quote, percent sign, or NUL in this Windows package'
    return None


def both(*validators):
    def check(value):
        for validator in validators:
            problem = validator(value)
            if problem:
                return problem
        return None
    return check


def hexish(length, what):
    def check(v):
        if not v:
            return None  # blank is allowed; the photo sync says so plainly later
        if re.search(r"[^0-9a-fA-F]", v):
            bad = re.sub(r"[0-9a-fA-F]", "", v)[:20]
            return f"{what} should be letters a-f and digits only — found {bad!r}"
        if len(v) != length:
            return f"{what} should be {length} characters, this is {len(v)}"
        return None
    return check


def is_agent_token(v):
    if not v:
        return "an organisation-wide Gati Connect agent token is required"
    if not re.fullmatch(r"cxa_[A-Za-z0-9._~-]{16,500}", v):
        return "that does not look like a CaratOS Connect token (expected cxa_...)"
    return None


def is_url(v):
    if not v.startswith("http://") and not v.startswith("https://"):
        return "should start with https://"
    if v.endswith("/"):
        return "should NOT end with a slash"
    return None


def is_backend_origin(v):
    try:
        normalize_backend_origin(v)
    except TargetSafetyError as exc:
        return str(exc)
    return None


def optional_website_endpoint(v):
    if not v:
        return None
    try:
        normalize_website_endpoint(v)
    except TargetSafetyError as exc:
        return str(exc)
    return None


def website_origin(v):
    try:
        normalize_website_origin(v)
    except TargetSafetyError as exc:
        return str(exc)
    return None


def folder_exists(v):
    if not v:
        return None
    if not os.path.isdir(v):
        return "that folder does not exist on this computer"
    return None


def main():
    print()
    print("=" * 60)
    print("  STEP 2 of 5 - SETTINGS")
    print("=" * 60)

    if os.path.exists(CONFIG):
        print("\n  A settings file already exists.")
        if input("  Replace it? (y/N): ").strip().lower() != "y":
            print("  Keeping the existing file. Nothing changed.")
            return 0
        try:
            with open(CONFIG, "rb") as a, open(BACKUP, "wb") as b:
                b.write(a.read())
            print("  Old settings saved as eclat_config.backup.bat")
        except Exception:
            pass

    print("\n--- YOUR JEWELLERY DATABASE ---\n")
    print("  If you are not sure, run 1_discover.bat — it prints these two.\n")
    sql_server = ask("SQL Server", "localhost", validate=batch_safe)
    sql_db = ask("Database name", "APRSSJEP", validate=batch_safe)

    print("\n  Database login. Ask IT to run create_readonly_login.sql.")
    print("  Leaving it blank uses the current Windows login. The scheduled")
    print("  task uses that same interactive user, so IT must grant it read access.\n")
    sql_user = ask(
        "Database username (blank = Windows login)", "", validate=batch_safe
    )
    sql_pass = (
        ask("Database password", "", secret=True, validate=batch_safe)
        if sql_user
        else ""
    )

    print("\n--- YOUR ECLAT DASHBOARD ---\n")
    print("  Enter the exact backend for this installation. There is deliberately")
    print("  no production default: the address you confirm becomes its safety pin.\n")
    base_url = ask("CaratOS backend address", "",
                   validate=both(is_backend_origin, batch_safe))
    base_url = normalize_backend_origin(base_url)
    agent_token = ask(
        "Organisation-wide Gati Connect token",
        "",
        secret=True,
        validate=both(is_agent_token, batch_safe),
    )

    print("\n--- OPTIONAL WEBSITE CATALOGUE FEED ---\n")
    print("  Leave blank unless this client has an approved product-feed URL.")
    website_api = ask(
        "Website product-feed URL",
        "",
        validate=both(optional_website_endpoint, batch_safe),
    )
    website_public_origin = ""
    if website_api:
        website_api = normalize_website_endpoint(website_api)
        website_public_origin = ask(
            "Website public origin",
            "",
            validate=both(website_origin, batch_safe),
            hint="e.g. https://shop.example.com (no path)",
        )
        website_public_origin = normalize_website_origin(website_public_origin)

    print("\n--- PHOTOGRAPHS ---\n")
    print("  The folder holding the jewellery pictures. 1_discover.bat finds it.")
    print("  Leave blank if you are not doing photos yet.\n")
    image_root = ask("Photo folder", "", validate=both(folder_exists, batch_safe),
                     hint="e.g. D:\\GATISOFTTECH\\SJEP IMAGES")

    print("\n--- PHOTO STORAGE (given to you by the Eclat team) ---\n")
    print("  Leave blank to skip photos for now.\n")
    r2_account = ask("R2 account id", "", validate=hexish(32, "the account id"))
    r2_key = ask(
        "R2 access key id", "", secret=True, validate=hexish(32, "the access key")
    )
    r2_secret = ask(
        "R2 secret key", "", secret=True, validate=hexish(64, "the secret key")
    )
    r2_bucket = ask("R2 bucket", "eclat-media", validate=batch_safe)
    r2_url = ask("R2 public address", "",
                 validate=lambda v: None if not v else (is_url(v) or batch_safe(v)))

    def mask(v):
        if not v:
            return "(blank)"
        return v[:4] + "…" + v[-4:] if len(v) > 12 else "*" * len(v)

    print("\n" + "=" * 60)
    print("  CHECK THIS BEFORE SAVING")
    print("=" * 60)
    for label, value in [
        ("SQL Server", sql_server),
        ("Database", sql_db),
        ("DB username", sql_user or "(Windows login)"),
        ("DB password", mask(sql_pass)),
        ("Eclat address", base_url),
        ("Gati agent token", mask(agent_token)),
        ("Website feed", website_api or "(none)"),
        ("Website origin", website_public_origin or "(none)"),
        ("Photo folder", image_root or "(none)"),
        ("R2 account id", r2_account or "(blank)"),
        ("R2 access key", r2_key or "(blank)"),
        ("R2 secret", mask(r2_secret)),
        ("R2 bucket", r2_bucket),
        ("R2 address", r2_url or "(blank)"),
    ]:
        print(f"  {label:<16} {value}")
    print()
    if input("  Is all of that correct? (y/N): ").strip().lower() != "y":
        print("\n  Nothing saved. Run this again.")
        return 1

    # Quoted form throughout: `set "K=V"` discards trailing whitespace after the
    # closing quote, which plain `set K=V` keeps — and the photo folder path
    # contains a space, so a stray one silently breaks it.
    lines = [
        "@echo off",
        "REM Written by 2_configure.bat - contains passwords, keep private.",
        f'set "ECLAT_BASE_URL={base_url}"',
        f'set "CARATOS_APPROVED_BACKEND_ORIGIN={base_url}"',
        f'set "CARATOS_AGENT_TOKEN={agent_token}"',
        f'set "ECLAT_WEBSITE_API={website_api}"',
        f'set "ECLAT_APPROVED_WEBSITE_API={website_api}"',
        f'set "ECLAT_WEBSITE_ORIGIN={website_public_origin}"',
        f'set "SJEP_SQL_SERVER={sql_server}"',
        f'set "SJEP_SQL_DB={sql_db}"',
        f'set "SJEP_SQL_USER={sql_user}"',
        f'set "SJEP_SQL_PASS={sql_pass}"',
        f'set "SJEP_IMAGE_ROOT={image_root}"',
        "REM Which folders inside the photo folder to use. Run",
        "REM   sync_media.bat --folders",
        "REM to list them, then set ONE of these (blank = use everything):",
        'set "SJEP_IMAGE_ONLY_FOLDERS="',
        'set "SJEP_IMAGE_SKIP_FOLDERS="',
        f'set "R2_ACCOUNT_ID={r2_account}"',
        f'set "R2_ACCESS_KEY_ID={r2_key}"',
        f'set "R2_SECRET_ACCESS_KEY={r2_secret}"',
        f'set "R2_BUCKET={r2_bucket}"',
        f'set "R2_PUBLIC_BASE_URL={r2_url}"',
    ]
    with open(CONFIG, "w", encoding="ascii", errors="replace", newline="\r\n") as f:
        f.write("\n".join(lines) + "\n")

    print("\n  Settings saved.")
    if not sql_user:
        print()
        print("  " + "*" * 56)
        print("  WARNING - Windows database authentication is selected.")
        print("  The automatic task runs only as this same interactive")
        print("  Windows user. Ask IT to grant this identity read access,")
        print("  then run step 3 as that user before installing the task.")
        print("  " + "*" * 56)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n  Cancelled. Nothing was saved.")
        sys.exit(1)
