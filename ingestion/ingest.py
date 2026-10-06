#!/usr/bin/env python3
"""
Ingest a small random sample of games from the Video Game Soda Machine Project.

The ingestion pipeline:
1. Discovers public VGSM WordPress posts through the REST API.
2. Selects five random posts.
3. Downloads their images locally.
4. Generates a normalized games.json dataset.
5. Generates an ingestion report for debugging.

This is intentionally a small prototype. The resulting dataset is designed
to become the contract between ingestion and the static guessing game.
"""

from __future__ import annotations

import json
import random
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import requests
from PIL import Image


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SITE_URL = "https://vgsmproject.com"
API_URL = f"{SITE_URL}/wp-json/wp/v2"

SAMPLE_SIZE = 5

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "app" / "data"
IMAGE_DIR = PROJECT_ROOT / "assets" / "images"

GAMES_FILE = DATA_DIR / "games.json"
REPORT_FILE = DATA_DIR / "ingestion-report.json"

REQUEST_TIMEOUT = 30

USER_AGENT = "VGSM-Guessing-Game-Ingest/0.1"


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": USER_AGENT})


def get_json(url: str, params: dict[str, Any] | None = None) -> Any:
    """GET a JSON resource and fail with a useful error message."""

    response = SESSION.get(
        url,
        params=params,
        timeout=REQUEST_TIMEOUT,
    )

    response.raise_for_status()

    return response.json()


# ---------------------------------------------------------------------------
# WordPress API
# ---------------------------------------------------------------------------


def get_posts() -> list[dict[str, Any]]:
    """
    Retrieve the available VGSM posts.

    WordPress paginates REST API responses, so walk through all pages.
    """

    posts: list[dict[str, Any]] = []
    page = 1

    while True:
        print(f"Fetching posts page {page}...")

        response = SESSION.get(
            f"{API_URL}/posts",
            params={
                "per_page": 100,
                "page": page,
                "_embed": "1",
            },
            timeout=REQUEST_TIMEOUT,
        )

        if response.status_code == 400:
            # WordPress returns 400 when the requested page is beyond
            # the final page.
            break

        response.raise_for_status()

        page_posts = response.json()

        if not page_posts:
            break

        posts.extend(page_posts)

        total_pages = int(response.headers.get("X-WP-TotalPages", page))

        print(f"  Found {len(page_posts)} posts.")

        if page >= total_pages:
            break

        page += 1

    return posts


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------


def clean_html(value: str) -> str:
    """Remove HTML tags and normalize whitespace."""

    value = re.sub(r"<[^>]+>", " ", value)
    value = re.sub(r"\s+", " ", value)

    return value.strip()


def normalize_text(value: str) -> str:
    """
    Normalize text for future guess matching.

    This intentionally does not attempt fuzzy matching yet. The game engine
    will build on this normalized representation later.
    """

    value = clean_html(value).lower()

    value = value.replace("&amp;", "and")
    value = re.sub(r"[™®©]", "", value)
    value = re.sub(r"[^a-z0-9]+", " ", value)

    return re.sub(r"\s+", " ", value).strip()


def get_featured_image(post: dict[str, Any]) -> dict[str, Any] | None:
    """Extract the featured image from an embedded WordPress post."""

    embedded = post.get("_embedded", {})
    media = embedded.get("wp:featuredmedia", [])

    if not media:
        return None

    image = media[0]

    source_url = image.get("source_url")

    if not source_url:
        return None

    return {
        "source_url": source_url,
        "alt": clean_html(image.get("alt_text", "")),
        "media_id": image.get("id"),
    }


def post_to_game(post: dict[str, Any]) -> dict[str, Any] | None:
    """Convert a WordPress post into our normalized game representation."""

    title = clean_html(post.get("title", {}).get("rendered", ""))

    if not title:
        return None

    image = get_featured_image(post)

    if image is None:
        return None

    normalized_name = normalize_text(title)

    return {
        "id": f"wp-{post['id']}",
        "name": title,
        "normalized_name": normalized_name,
        "aliases": [],
        "series": None,
        "accept": [normalized_name],
        "partial": [],
        "article": post.get("link"),
        "source": {
            "site": "vgsm",
            "url": post.get("link"),
            "post_id": post.get("id"),
        },
        "images": [
            {
                "source_url": image["source_url"],
                "path": None,
                "alt": image["alt"],
                "media_id": image["media_id"],
            }
        ],
    }


# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------


def safe_extension(url: str, content_type: str | None = None) -> str:
    """Determine a safe local image extension."""

    extension = Path(urlparse(url).path).suffix.lower()

    if extension in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
        return extension

    content_type = (content_type or "").lower()

    extensions = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
    }

    return extensions.get(content_type, ".jpg")


def download_image(game: dict[str, Any], image: dict[str, Any]) -> str:
    """Download an image and return its relative local path."""

    source_url = image["source_url"]

    print(f"  Downloading {source_url}")

    response = SESSION.get(
        source_url,
        timeout=REQUEST_TIMEOUT,
    )

    response.raise_for_status()

    extension = safe_extension(
        source_url,
        response.headers.get("Content-Type"),
    )

    filename = f"{game['id']}{extension}"
    destination = IMAGE_DIR / filename

    destination.write_bytes(response.content)

    # Validate that we actually downloaded an image.
    with Image.open(destination) as downloaded:
        downloaded.verify()

    relative_path = f"/assets/images/{filename}"

    return relative_path


# ---------------------------------------------------------------------------
# Dataset
# ---------------------------------------------------------------------------


def ensure_directories() -> None:
    """Create generated-data directories."""

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)


def write_json(path: Path, data: Any) -> None:
    """Write formatted UTF-8 JSON."""

    path.write_text(
        json.dumps(
            data,
            indent=2,
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    """Run the ingestion pipeline."""

    print("VGSM Guessing Game ingestion")
    print("=============================")

    ensure_directories()

    try:
        posts = get_posts()
    except requests.RequestException as exc:
        print(f"ERROR: Unable to retrieve VGSM posts: {exc}", file=sys.stderr)
        return 1

    print(f"\nDiscovered {len(posts)} posts.")

    candidates: list[dict[str, Any]] = []
    skipped = 0

    for post in posts:
        game = post_to_game(post)

        if game is None:
            skipped += 1
            continue

        candidates.append(game)

    print(f"Usable posts with featured images: {len(candidates)}")
    print(f"Skipped posts: {skipped}")

    if len(candidates) < SAMPLE_SIZE:
        print(
            f"ERROR: Only {len(candidates)} usable posts found; "
            f"need {SAMPLE_SIZE}.",
            file=sys.stderr,
        )
        return 1

    # Random sampling is deliberately performed after normalization so
    # every selected entry is known to be usable.
    selected = random.sample(candidates, SAMPLE_SIZE)

    print(f"\nSelected {len(selected)} games:\n")

    successful_games: list[dict[str, Any]] = []
    warnings: list[str] = []

    for game in selected:
        print(f"- {game['name']}")

        for image in game["images"]:
            try:
                image["path"] = download_image(game, image)
            except (requests.RequestException, OSError, ValueError) as exc:
                warning = (
                    f"Could not download image for "
                    f"{game['name']}: {exc}"
                )

                print(f"  WARNING: {warning}")
                warnings.append(warning)

        # Only keep games for which at least one image downloaded.
        if any(image["path"] for image in game["images"]):
            successful_games.append(game)
        else:
            warnings.append(
                f"No images downloaded for {game['name']}."
            )

    dataset = {
        "schema_version": 1,
        "source": {
            "name": "Video Game Soda Machine Project",
            "url": SITE_URL,
        },
        "games": successful_games,
    }

    report = {
        "schema_version": 1,
        "source": SITE_URL,
        "discovered_posts": len(posts),
        "usable_posts": len(candidates),
        "requested_samples": SAMPLE_SIZE,
        "successful_games": len(successful_games),
        "skipped_posts": skipped,
        "warnings": warnings,
    }

    write_json(GAMES_FILE, dataset)
    write_json(REPORT_FILE, report)

    print("\nGenerated:")
    print(f"  {GAMES_FILE}")
    print(f"  {REPORT_FILE}")

    if warnings:
        print(f"\nCompleted with {len(warnings)} warning(s).")
    else:
        print("\nCompleted successfully.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
