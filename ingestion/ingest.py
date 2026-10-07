#!/usr/bin/env python3
"""
Ingest the complete Video Game Soda Machine Project catalog.

VGSM stores many of its images directly inside post content rather than as
WordPress featured images.

WordPress also generates multiple responsive versions of the same image,
such as:

    game.jpg
    game-300x150.jpg
    game-768x384.jpg
    game-1024x512.jpg

This importer treats those as one logical image and selects the largest
available version.

The resulting dataset is independent of WordPress so the static game
application does not need to know anything about the source site.

IMPORTANT DATA POLICY

This importer is append-only with respect to games.json:

- Existing games are never reordered.
- Existing games are never replaced or rewritten from WordPress.
- Existing games remain even if they disappear from the source.
- Newly discovered games are appended in WordPress API order.
- Existing image files are never overwritten.
- New images are downloaded only when needed.

This gives the game catalog a stable history while allowing future VGSM
posts to be added automatically.
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
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

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "app" / "data"
IMAGE_DIR = PROJECT_ROOT / "assets" / "images"

GAMES_FILE = DATA_DIR / "games.json"
REPORT_FILE = DATA_DIR / "ingestion-report.json"

REQUEST_TIMEOUT = 30

USER_AGENT = "VGSM-Guessing-Game-Ingest/0.3"


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


# ---------------------------------------------------------------------------
# WordPress API
# ---------------------------------------------------------------------------


def get_posts() -> list[dict[str, Any]]:
    """Retrieve all published VGSM posts in WordPress API order."""

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

        # WordPress returns 400 when the requested page is beyond the
        # available number of pages.
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
    Normalize text for guess matching.

    Unicode characters are decomposed first so names such as:

        Hōsoku
        Jūdan

    become:

        Hosoku
        Judan

    before punctuation and whitespace normalization.
    """

    value = clean_html(value).lower()

    value = unicodedata.normalize("NFKD", value)
    value = value.encode("ascii", "ignore").decode("ascii")

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
    "favicon",
    "emoji",
    "wp-includes/images",
)


WORDPRESS_SIZE_PATTERN = re.compile(
    r"-(\d{2,5})x(\d{2,5})(?=\.[^.]+$)",
    re.IGNORECASE,
)


def is_candidate_image_url(url: str) -> bool:
    """Return True when a URL looks like an article image."""

    if not url:
        return False

    parsed = urlparse(url)

    if parsed.scheme not in {"http", "https"}:
        return False

    lowered = url.lower()

    if any(
        pattern in lowered
        for pattern in IGNORED_IMAGE_PATTERNS
    ):
        return False

    path = parsed.path.lower()

    return path.endswith(
        (
            ".jpg",
            ".jpeg",
            ".png",
            ".webp",
            ".gif",
            ".avif",
        )
    )


def wordpress_image_key(url: str) -> str:
    """
    Return a normalized key for a WordPress image.

    Example:

        foo.jpg
        foo-300x150.jpg
        foo-1024x512.jpg

    all become:

        foo.jpg
    """

    parsed = urlparse(url)

    path = WORDPRESS_SIZE_PATTERN.sub(
        "",
        parsed.path,
    )

    return f"{parsed.scheme}://{parsed.netloc}{path}"


def parse_srcset(srcset: str) -> list[tuple[str, int]]:
    """
    Parse a srcset into (URL, width) pairs.

    We primarily care about width because it lets us choose the largest
    responsive image.
    """

    candidates: list[tuple[str, int]] = []

    for entry in srcset.split(","):
        parts = entry.strip().split()

        if not parts:
            continue

        url = parts[0]
        width = 0

        if len(parts) > 1:
            descriptor = parts[1]

            match = re.match(
                r"(\d+)w",
                descriptor,
            )

            if match:
                width = int(match.group(1))

        candidates.append((url, width))

    return candidates


def extract_image_urls(
    content_html: str,
) -> list[dict[str, Any]]:
    """
    Extract logical article images.

    Each HTML <img> represents one logical image. If it contains a srcset,
    the largest candidate is selected rather than treating every responsive
    size as a separate image.
    """

    soup = BeautifulSoup(
        content_html,
        "html.parser",
    )

    images: list[dict[str, Any]] = []
    seen_keys: set[str] = set()

    for image in soup.find_all("img"):
        candidates: list[tuple[str, int]] = []

        for attribute in (
            "src",
            "data-src",
            "data-lazy-src",
            "data-original",
        ):
            value = image.get(attribute)

            if value:
                candidates.append(
                    (
                        value,
                        0,
                    )
                )

        srcset = image.get("srcset")

        if srcset:
            candidates.extend(
                parse_srcset(srcset)
            )

        normalized_candidates: list[
            tuple[str, int]
        ] = []

        for candidate, width in candidates:
            absolute_url = urljoin(
                SITE_URL,
                candidate,
            )

            if not is_candidate_image_url(
                absolute_url
            ):
                continue

            normalized_candidates.append(
                (
                    absolute_url,
                    width,
                )
            )

        if not normalized_candidates:
            continue

        # Prefer the candidate with the greatest declared width.
        # When widths are unavailable, the first candidate wins.
        normalized_candidates.sort(
            key=lambda item: item[1],
            reverse=True,
        )

        selected_url = normalized_candidates[0][0]

        key = wordpress_image_key(
            selected_url
        )

        if key in seen_keys:
            continue

        seen_keys.add(key)

        images.append(
            {
                "source_url": selected_url,
                "alt": image.get(
                    "alt",
                    "",
                ),
            }
        )

    return images


# ---------------------------------------------------------------------------
# Post normalization
# ---------------------------------------------------------------------------


def post_to_game(
    post: dict[str, Any],
) -> dict[str, Any] | None:
    """Convert a WordPress post into our normalized game representation."""

    title = clean_html(
        post.get("title", {}).get(
            "rendered",
            "",
        )
    )

    if not title:
        return None

    content_html = post.get(
        "content",
        {},
    ).get(
        "rendered",
        "",
    )

    images = extract_image_urls(
        content_html
    )

    if not images:
        return None

    normalized_name = normalize_text(
        title
    )

    return {
        "id": f"wp-{post['id']}",
        "name": title,
        "normalized_name": normalized_name,
        "aliases": [],
        "series": None,
        "accept": [
            normalized_name
        ],
        "partial": [],
        "article": post.get("link"),
        "source": {
            "site": "vgsm",
            "url": post.get("link"),
            "post_id": post.get("id"),
            "date": post.get("date"),
        },
        "categories": post.get(
            "categories",
            [],
        ),
        "tags": post.get(
            "tags",
            [],
        ),
        "images": [
            {
                "source_url": image[
                    "source_url"
                ],
                "path": None,
                "alt": image["alt"],
                "width": None,
                "height": None,
            }
            for image in images
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

    content_type = (
        content_type or ""
    ).lower()

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


def image_dimensions(
    path: Path,
) -> tuple[int, int]:
    """Read and validate an existing image."""

    with Image.open(path) as image:
        image.verify()

    with Image.open(path) as image:
        return image.size


def download_image(
    game: dict[str, Any],
    image: dict[str, Any],
    image_index: int,
) -> str:
    """
    Download an image without overwriting an existing file.

    If the expected destination already exists and is a valid image, it is
    reused. This makes ingestion safe to rerun.
    """

    source_url = image[
        "source_url"
    ]

    extension = safe_extension(
        source_url
    )

    filename = (
        f"{game['id']}-"
        f"{image_index + 1}"
        f"{extension}"
    )

    destination = (
        IMAGE_DIR / filename
    )

    # Never overwrite an existing image.
    if destination.exists():
        print(
            f"    Reusing existing image: "
            f"{destination.name}"
        )

        try:
            width, height = image_dimensions(
                destination
            )

            image["width"] = width
            image["height"] = height

            return (
                f"assets/images/"
                f"{filename}"
            )

        except (
            OSError,
            ValueError,
        ) as exc:
            print(
                f"    Existing image is invalid; "
                f"redownloading: {exc}"
            )

            # We only remove the file after validation fails.
            destination.unlink()

    print(
        f"    Downloading image "
        f"{image_index + 1}: "
        f"{source_url}"
    )

    response = SESSION.get(
        source_url,
        timeout=REQUEST_TIMEOUT,
    )

    response.raise_for_status()

    # Recalculate the extension from the response because some URLs do not
    # have useful file extensions.
    extension = safe_extension(
        source_url,
        response.headers.get(
            "Content-Type"
        ),
    )

    filename = (
        f"{game['id']}-"
        f"{image_index + 1}"
        f"{extension}"
    )

    destination = (
        IMAGE_DIR / filename
    )

    # Never overwrite an existing file even if the content type changed.
    if destination.exists():
        print(
            f"    Existing destination appeared "
            f"during ingestion; keeping it: "
            f"{destination.name}"
        )

        width, height = image_dimensions(
            destination
        )

        image["width"] = width
        image["height"] = height

        return (
            f"assets/images/"
            f"{filename}"
        )

    destination.write_bytes(
        response.content
    )

    width, height = image_dimensions(
        destination
    )

    image["width"] = width
    image["height"] = height

    return (
        f"assets/images/"
        f"{filename}"
    )


# ---------------------------------------------------------------------------
# Existing dataset
# ---------------------------------------------------------------------------


def load_existing_games() -> list[dict[str, Any]]:
    """
    Load the existing catalog.

    An absent games.json means this is the initial import.
    """

    if not GAMES_FILE.exists():
        return []

    try:
        data = json.loads(
            GAMES_FILE.read_text(
                encoding="utf-8"
            )
        )

    except (
        OSError,
        json.JSONDecodeError,
    ) as exc:
        print(
            f"ERROR: Could not read existing "
            f"{GAMES_FILE}: {exc}",
            file=sys.stderr,
        )
        raise

    games = data.get(
        "games",
        [],
    )

    if not isinstance(games, list):
        raise ValueError(
            f"Expected 'games' to be a list "
            f"in {GAMES_FILE}"
        )

    return games


def existing_game_ids(
    games: list[dict[str, Any]],
) -> set[str]:
    """Return IDs already present in the catalog."""

    return {
        str(game["id"])
        for game in games
        if game.get("id")
    }


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
    """Run the append-only ingestion pipeline."""

    print(
        "VGSM Guessing Game ingestion"
    )
    print(
        "============================="
    )
    print(
        "Mode: complete catalog / append-only"
    )

    ensure_directories()

    # -----------------------------------------------------------------------
    # Load existing catalog FIRST.
    #
    # This is the important bit: the existing catalog becomes immutable
    # source data for this ingestion run.
    # -----------------------------------------------------------------------

    try:
        existing_games = load_existing_games()

    except (
        OSError,
        ValueError,
        json.JSONDecodeError,
    ):
        return 1

    existing_ids = existing_game_ids(
        existing_games
    )

    print(
        f"\nExisting catalog: "
        f"{len(existing_games)} games."
    )

    try:
        posts = get_posts()

    except requests.RequestException as exc:
        print(
            f"ERROR: Unable to retrieve VGSM "
            f"posts: {exc}",
            file=sys.stderr,
        )
        return 1

    print(
        f"\nDiscovered {len(posts)} posts."
    )

    # -----------------------------------------------------------------------
    # Convert every source post to a candidate.
    # -----------------------------------------------------------------------

    candidates: list[
        dict[str, Any]
    ] = []

    skipped_no_image = 0

    for post in posts:
        game = post_to_game(post)

        if game is None:
            skipped_no_image += 1
            continue

        candidates.append(game)

    print(
        "Usable posts with logical "
        f"article images: {len(candidates)}"
    )

    print(
        "Skipped posts without article "
        f"images: {skipped_no_image}"
    )

    # -----------------------------------------------------------------------
    # Find genuinely new games.
    #
    # Do NOT replace existing objects, even if WordPress has changed them.
    # -----------------------------------------------------------------------

    new_games = [
        game
        for game in candidates
        if game["id"] not in existing_ids
    ]

    print(
        f"New games to append: "
        f"{len(new_games)}"
    )

    # -----------------------------------------------------------------------
    # Download images only for new games.
    # -----------------------------------------------------------------------

    successful_new_games: list[
        dict[str, Any]
    ] = []

    warnings: list[str] = []

    for game in new_games:
        print(
            f"\n- {game['name']} "
            f"({len(game['images'])} "
            "logical image(s))"
        )

        downloaded_count = 0

        for index, image in enumerate(
            game["images"]
        ):
            try:
                image["path"] = (
                    download_image(
                        game,
                        image,
                        index,
                    )
                )

                downloaded_count += 1

            except (
                requests.RequestException,
                OSError,
                ValueError,
            ) as exc:
                warning = (
                    f"Could not download "
                    f"image for {game['name']}: "
                    f"{exc}"
                )

                print(
                    f"    WARNING: {warning}"
                )

                warnings.append(
                    warning
                )

        if downloaded_count:
            successful_new_games.append(
                game
            )
        else:
            warnings.append(
                f"No images downloaded for "
                f"{game['name']}."
            )

    # -----------------------------------------------------------------------
    # Build the catalog.
    #
    # Existing games FIRST, in their exact existing order.
    # New games SECOND, in WordPress API order.
    # -----------------------------------------------------------------------

    all_games = (
        existing_games
        + successful_new_games
    )

    dataset = {
        "schema_version": 1,
        "source": {
            "name": (
                "Video Game Soda Machine "
                "Project"
            ),
            "url": SITE_URL,
        },
        "games": all_games,
    }

    report = {
        "schema_version": 1,
        "source": SITE_URL,
        "discovered_posts": len(posts),
        "usable_posts": len(candidates),
        "existing_games": len(
            existing_games
        ),
        "new_games_discovered": len(
            new_games
        ),
        "new_games_added": len(
            successful_new_games
        ),
        "total_games": len(all_games),
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

    print(
        f"\nCatalog: "
        f"{len(existing_games)} existing + "
        f"{len(successful_new_games)} new = "
        f"{len(all_games)} total games."
    )

    if warnings:
        print(
            f"\nCompleted with "
            f"{len(warnings)} warning(s)."
        )
    else:
        print(
            "\nCompleted successfully."
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
