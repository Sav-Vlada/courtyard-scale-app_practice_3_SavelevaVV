#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Удобный локальный сервер: корень проекта, приложение на /app/.

Запуск:
    python scripts/serve.py
    python scripts/serve.py --port 8080 --no-browser

Эквивалент без скрипта:
    python -m http.server 8000
    # затем открыть http://localhost:8000/app/
"""

from __future__ import annotations

import argparse
import http.server
import os
import socketserver
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser(description="Локальный сервер приложения")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()

    os.chdir(ROOT)
    handler = http.server.SimpleHTTPRequestHandler

    class ReusableTCPServer(socketserver.TCPServer):
        allow_reuse_address = True

    with ReusableTCPServer(("127.0.0.1", args.port), handler) as httpd:
        url = f"http://localhost:{args.port}/app/"
        print(f"Корень проекта: {ROOT}")
        print(f"Приложение:    {url}")
        print("Остановка: Ctrl+C")
        if not args.no_browser:
            webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nСервер остановлен.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
