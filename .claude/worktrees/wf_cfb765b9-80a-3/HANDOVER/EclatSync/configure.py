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
        raw = input(f"  {label}{shown}: ")
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


def is_email(v):
    if not v:
        return "an email is required for the sync account"
    if "@" not in v or " " in v:
        return "that does not look like an email address"
    return None


def is_url(v):
    if not v.startswith("http://") and not v.startswith("https://"):
        return "should start with https://"
    if v.endswith("/"):
        return "should NOT end with a slash"
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
    sql_server = ask("SQL Server", "localhost")
    sql_db = ask("Database name", "APRSSJEP")

    print("\n  Database login. Ask IT to run create_readonly_login.sql.")
    print("  Leaving it blank uses the Windows login, which works while you")
    print("  run things by hand and then FAILS once the sync is automatic.\n")
    sql_user = ask("Database username (blank = Windows login)", "", validate=optional)
    sql_pass = ask("Database password", "", validate=optional) if sql_user else ""

    print("\n--- YOUR ECLAT DASHBOARD ---\n")
    base_url = ask("Eclat address", "https://backend-production-89dd.up.railway.app",
                   validate=is_url)
    email = ask("Eclat sync email", "", validate=is_email)
    password = ask("Eclat sync password", "", validate=lambda v: None if v else "required")

    print("\n--- PHOTOGRAPHS ---\n")
    print("  The folder holding the jewellery pictures. 1_discover.bat finds it.")
    print("  Leave blank if you are not doing photos yet.\n")
    image_root = ask("Photo folder", "", validate=folder_exists,
                     hint="e.g. D:\\GATISOFTTECH\\SJEP IMAGES")

    print("\n--- PHOTO STORAGE (given to you by the Eclat team) ---\n")
    print("  Leave blank to skip photos for now.\n")
    r2_account = ask("R2 account id", "", validate=hexish(32, "the account id"))
    r2_key = ask("R2 access key id", "", validate=hexish(32, "the access key"))
    r2_secret = ask("R2 secret key", "", validate=hexish(64, "the secret key"))
    r2_bucket = ask("R2 bucket", "eclat-media")
    r2_url = ask("R2 public address", "",
                 validate=lambda v: None if not v else is_url(v))

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
        ("Eclat email", email),
        ("Eclat password", mask(password)),
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
        f'set "ECLAT_EMAIL={email}"',
        f'set "ECLAT_PASSWORD={password}"',
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
        print("  WARNING - no database login was given.")
        print("  The test below may pass, but the AUTOMATIC sync will")
        print("  probably fail, because it runs as the computer rather")
        print("  than as you. Ask IT to run create_readonly_login.sql,")
        print("  then run this step again before install_scheduler.bat.")
        print("  " + "*" * 56)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n  Cancelled. Nothing was saved.")
        sys.exit(1)
