#!/usr/bin/env python3
"""
Ingest a random sample of games from the Video Game Soda Machine Project.

VGSM stores many of its images directly inside post content rather than as
WordPress featured images. This ingestion process therefore extracts image
URLs from the rendered post content returned by the WordPress REST API.

The resulting dataset is deliberately independent of WordPress so that the
static game application does not need to know anything about the source site.
"""

from __future__ import annotations

import json
import random
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup
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

SESSION.headers.update(
    {
        "User-Agent": USER_AGENT,
        "Accept": "application/json, text/html, image/avif,image/webp,image/*",
    }
)


def get_json(
    url: str,
    params: dict[str, Any] | None = None,
) -> Any:
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
    Retrieve all published VGSM posts.

    WordPress paginates REST API responses, so walk through all pages.
    Only request fields needed by the ingestion process.
    """

    posts: list[dict[str, Any]] = []
    page = 1

    fields = ",".join(
        [
            "id",
            "date",
            "link",
            "title",
            "content",
            "categories",
            "tags",
        ]
    )

    while True:
        print(f"Fetching posts page {page}...")

        response = SESSION.get(
            f"{API_URL}/posts",
            params={
                "per_page": 100,
                "page": page,
                "status": "publish",
                "_fields": fields,
            },
            timeout=REQUEST_TIMEOUT,
        )

        # WordPress uses HTTP 400 when the requested page is beyond the
        # final page.
        if response.status_code == 400:
            break

        response.raise_for_status()

        page_posts = response.json()

        if not page_posts:
            break

        posts.extend(page_posts)

        total_pages = int(
            response.headers.get(
                "X-WP-TotalPages",
                page,
            )
        )

        print(f"  Found {len(page_posts)} posts.")

        if page >= total_pages:
            break

        page += 1

    return posts


# ---------------------------------------------------------------------------
# Text normalization
# ---------------------------------------------------------------------------


def clean_html(value: str) -> str:
    """Remove HTML tags and normalize whitespace."""

    value = re.sub(r"<[^>]+>", " ", value)
    value = re.sub(r"\s+", " ", value)

    return value.strip()


def normalize_text(value: str) -> str:
    """
    Normalize text for future guess matching.

    Fuzzy matching and partial-credit rules intentionally live in the game
    engine rather than the ingestion layer.
    """

    value = clean_html(value).lower()

    value = value.replace("&amp;", "and")
    value = re.sub(r"[™®©]", "", value)
    value = re.sub(r"[^a-z0-9]+", " ", value)

    return re.sub(r"\s+", " ", value).strip()


# ---------------------------------------------------------------------------
# Image extraction
# ---------------------------------------------------------------------------


IGNORED_IMAGE_PATTERNS = (
    "gravatar",
    "avatar",
    "logo",
    "icon",
    "favicon",
    "emoji",
    "wp-includes/images",
)


def is_candidate_image_url(url: str) -> bool:
    """Return True when a URL looks like an article image."""

    if not url:
        return False

    parsed = urlparse(url)

    if parsed.scheme not in {"http", "https"}:
        return False

    lowered = url.lower()

    if any(pattern in lowered for pattern in IGNORED_IMAGE_PATTERNS):
        return False

    path = parsed.path.lower()

    if path.endswith(
        (
            ".jpg",
            ".jpeg",
            ".png",
            ".webp",
            ".gif",
            ".avif",
        )
    ):
        return True

    return False


def extract_image_urls(content_html: str) -> list[str]:
    """
    Extract article image URLs from WordPress post content.

    Supports:
    - normal src attributes
    - lazy-loaded data-src attributes
    - srcset attributes
    - absolute and relative URLs
    """

    soup = BeautifulSoup(content_html, "html.parser")

    image_urls: list[str] = []

    for image in soup.find_all("img"):
        candidates: list[str] = []

        for attribute in (
            "src",
            "data-src",
            "data-lazy-src",
            "data-original",
        ):
            value = image.get(attribute)

            if value:
                candidates.append(value)

        srcset = image.get("srcset")

        if srcset:
            for entry in srcset.split(","):
                url = entry.strip().split(" ")[0]

                if url:
                    candidates.append(url)

        for candidate in candidates:
            absolute_url = urljoin(SITE_URL, candidate)

            if not is_candidate_image_url(absolute_url):
                continue

            if absolute_url not in image_urls:
                image_urls.append(absolute_url)

    return image_urls


# ---------------------------------------------------------------------------
# Post normalization
# ---------------------------------------------------------------------------


def post_to_game(post: dict[str, Any]) -> dict[str, Any] | None:
    """Convert a WordPress post into our normalized game representation."""

    title = clean_html(
        post.get("title", {}).get("rendered", "")
    )

    if not title:
        return None

    content_html = post.get("content", {}).get("rendered", "")

    image_urls = extract_image_urls(content_html)

    if not image_urls:
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
            "date": post.get("date"),
        },
        "categories": post.get("categories", []),
        "tags": post.get("tags", []),
        "images": [
            {
                "source_url": url,
                "path": None,
                "alt": "",
            }
            for url in image_urls
        ],
    }


# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------


def safe_extension(
    url: str,
    content_type: str | None = None,
) -> str:
    """Determine a safe local image extension."""

    extension = Path(
        urlparse(url).path
    ).suffix.lower()

    if extension in {
        ".jpg",
        ".jpeg",
        ".png",
        ".webp",
        ".gif",
        ".avif",
    }:
        return extension

    content_type = (content_type or "").lower()

    extensions = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "image/gif": ".gif",
        "image/avif": ".avif",
    }

    return extensions.get(
        content_type,
        ".jpg",
    )


def download_image(
    game: dict[str, Any],
    image: dict[str, Any],
    image_index: int,
) -> str:
    """Download an image and return its relative local path."""

    source_url = image["source_url"]

    print(f"    Downloading image {image_index + 1}: {source_url}")

    response = SESSION.get(
        source_url,
        timeout=REQUEST_TIMEOUT,
    )

    response.raise_for_status()

    extension = safe_extension(
        source_url,
        response.headers.get("Content-Type"),
    )

    filename = (
        f"{game['id']}-{image_index + 1}{extension}"
    )

    destination = IMAGE_DIR / filename

    destination.write_bytes(response.content)

    # Validate that the response really is an image.
    with Image.open(destination) as downloaded:
        downloaded.verify()

    return f"/assets/images/{filename}"


# ---------------------------------------------------------------------------
# Dataset
# ---------------------------------------------------------------------------


def ensure_directories() -> None:
    """Create generated-data directories."""

    DATA_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    IMAGE_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )


def write_json(
    path: Path,
    data: Any,
) -> None:
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
        print(
            f"ERROR: Unable to retrieve VGSM posts: {exc}",
            file=sys.stderr,
        )
        return 1

    print(f"\nDiscovered {len(posts)} posts.")

    candidates: list[dict[str, Any]] = []
    skipped_no_image = 0

    for post in posts:
        game = post_to_game(post)

        if game is None:
            skipped_no_image += 1
            continue

        candidates.append(game)

    print(
        f"Usable posts with article images: "
        f"{len(candidates)}"
    )

    print(
        f"Skipped posts without article images: "
        f"{skipped_no_image}"
    )

    if len(candidates) < SAMPLE_SIZE:
        print(
            f"ERROR: Only {len(candidates)} usable posts found; "
            f"need {SAMPLE_SIZE}.",
            file=sys.stderr,
        )
        return 1

    # Select five random usable posts.
    selected = random.sample(
        candidates,
        SAMPLE_SIZE,
    )

    print(
        f"\nSelected {len(selected)} games:\n"
    )

    successful_games: list[dict[str, Any]] = []
    warnings: list[str] = []

    for game in selected:
        print(
            f"- {game['name']} "
            f"({len(game['images'])} source image(s))"
        )

        downloaded_count = 0

        for index, image in enumerate(game["images"]):
            try:
                image["path"] = download_image(
                    game,
                    image,
                    index,
                )

                downloaded_count += 1

            except (
                requests.RequestException,
                OSError,
                ValueError,
            ) as exc:
                warning = (
                    f"Could not download image for "
                    f"{game['name']}: {exc}"
                )

                print(
                    f"    WARNING: {warning}"
                )

                warnings.append(warning)

        if downloaded_count:
            successful_games.append(game)

        else:
            warnings.append(
                f"No images downloaded for "
                f"{game['name']}."
            )

    dataset = {
        "schema_version": 1,
        "source": {
            "name": (
                "Video Game Soda Machine Project"
            ),
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
        "skipped_posts_without_images": (
            skipped_no_image
        ),
        "warnings": warnings,
    }

    write_json(
        GAMES_FILE,
        dataset,
    )

    write_json(
        REPORT_FILE,
        report,
    )

    print("\nGenerated:")
    print(f"  {GAMES_FILE}")
    print(f"  {REPORT_FILE}")

    if warnings:
        print(
            f"\nCompleted with "
            f"{len(warnings)} warning(s)."
        )
    else:
        print("\nCompleted successfully.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
