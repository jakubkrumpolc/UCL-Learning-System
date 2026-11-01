#!/usr/bin/env python3
"""Start the UCL CS Learning System on this computer.

Double-click this file, or run it from a terminal in this folder:

    python3 start.py          (on Windows: py start.py)
    python3 start.py 8080     to use a port other than 8000

It serves the portal, opens it in your browser and runs Scribe's
transcription server. Leave the window open while you study.
"""

# Keep this file readable by old Pythons, so they can say what's wrong.
import os
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
TITLE = "UCL CS Learning System"


def set_window_title():
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.kernel32.SetConsoleTitleW(TITLE)
        except Exception:
            pass


def hold_window():
    """Keep a double-clicked window open long enough to read the message."""
    if sys.stdin is not None and sys.stdin.isatty():
        try:
            input("\nPress Return to close this window. ")
        except Exception:
            pass


def run():
    if sys.version_info < (3, 7):
        sys.stderr.write(
            "Python 3.7 or newer is required (this is Python %d.%d).\n"
            "Install it from https://www.python.org/downloads/ "
            "and run this file again.\n" % sys.version_info[:2]
        )
        return 1
    sys.path.insert(0, os.path.join(HERE, "server"))
    import serve

    return serve.main()


if __name__ == "__main__":
    set_window_title()
    try:
        status = run()
    except KeyboardInterrupt:
        print("\nStopped.")
        status = 0
    except Exception:
        traceback.print_exc()
        status = 1
    if status:
        hold_window()
    sys.exit(status)
