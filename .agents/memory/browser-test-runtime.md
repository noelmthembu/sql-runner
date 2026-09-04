---
name: Browser test runtime
description: Replit workspace requirements for running Playwright browser tests.
---

Playwright's bundled Chromium does not include Linux runtime libraries. In this workspace, browser tests need the standard headless-browser Nix libraries, including GLib, GBM, and xkbcommon, available to the test process.

**Why:** A browser suite can discover the test files and still fail before opening a page if Chromium cannot resolve its shared libraries.

**How to apply:** Keep the required Nix runtime packages configured with the workspace whenever Playwright end-to-end tests are added or run here.