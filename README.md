# Pop Quiz

A Wordle-style video game guessing game powered by the
[Video Game Soda Machine Project](https://vgsmproject.com/).

Pop Quiz shows you a pixelated image from the VGSM catalog and gives you
six guesses to identify the video game.

The image becomes clearer as you play.

🟩 Exact match  
🟨 Close or related title  
⬜ Wrong answer

## Play

**Live game:**  
https://sedward5.github.io/soda-guesser/

The game has two modes:

- **Daily Game** — everyone gets the same puzzle for the day.
- **Free Play** — play random puzzles from the catalog.

Your progress is stored locally in your browser.

---

## Why this exists

The Video Game Soda Machine Project is an excellent catalog of video game
advertising and promotional material.

Pop Quiz is a small experiment built on top of that catalog to turn those
images into a playable guessing game.

The project is intentionally:

- Static
- Serverless
- Open source
- Easy to run locally
- Easy to deploy with GitHub Pages
- Friendly to contributions

The game does not require a database or application server.

---

## Architecture

The project has three major pieces:

```text
VGSM WordPress API
        │
        ▼
   ingestion.py
        │
        ├── Download images
        ├── Extract game metadata
        ├── Normalize image URLs
        └── Generate games.json
        │
        ▼
   Static game data
        │
        ├── app/data/games.json
        └── assets/images/
        │
        ▼
    Browser game
        │
        ├── Daily puzzle
        ├── Free Play
        ├── Guess matching
        ├── Pixelation
        └── Local progress
        │
        ▼
    GitHub Pages
```

The **ingestion layer is deliberately separate from the game engine**.

That means the generated JSON is the contract between the source data and
the game. A future application, such as a WordPress plugin, could generate
the same schema without requiring changes to the game itself.

---

## Repository structure

```text
vgsm-guessing-game/
├── app/
│   ├── index.html
│   ├── styles.css
│   ├── game.js
│   └── data/
│       └── games.json
│
├── assets/
│   └── images/
│
├── ingestion/
│   ├── ingest.py
│   └── requirements.txt
│
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   └── puzzle-issue.yml
│   └── workflows/
│       ├── ingest.yml
│       └── deploy.yml
│
└── README.md
```

---

## Data source

Game data comes from the public WordPress API for the
[Video Game Soda Machine Project](https://vgsmproject.com/).

The ingestion process retrieves published posts and extracts:

- WordPress post ID
- Game title
- Source URL
- Publication date
- Categories
- Tags
- Article content
- Image URLs
- Image dimensions

Each game receives a stable identifier based on the original WordPress
post ID.

For example:

```json
{
  "id": "wp-10243",
  "name": "Epic Skater 2",
  "source": {
    "site": "vgsm",
    "url": "https://vgsmproject.com/...",
    "post_id": 10243,
    "date": "..."
  }
}
```

### Why the WordPress ID matters

The WordPress post ID is the canonical identity of a puzzle.

Titles can be incorrect, changed, duplicated, or ambiguous.

The post ID lets us identify exactly which source record produced a puzzle.

This is especially useful when reporting problems such as:

- Wrong image
- Missing image
- Broken image
- Image from another game
- Incorrect game title
- Incorrect source article
- Duplicate puzzle
- Other metadata problems

---

## Running locally

You only need Python and a simple static web server.

### 1. Clone the repository

```bash
git clone https://github.com/sedward5/soda-guesser.git
cd soda-guesser
```

### 2. Install ingestion dependencies

```bash
python -m pip install -r ingestion/requirements.txt
```

### 3. Run the ingestion process

```bash
python ingestion/ingest.py
```

This updates:

```text
app/data/games.json
assets/images/
```

### 4. Run the game locally

From the repository root:

```bash
python -m http.server
```

Then open:

```text
http://localhost:8000/app/
```

A local HTTP server is recommended rather than opening `index.html`
directly because browsers restrict some JavaScript and asset behavior when
using `file://`.

---

## Ingestion

The ingestion script retrieves the VGSM catalog and builds the static data
used by the game.

The GitHub Action can also run the ingestion process automatically.

The workflow:

1. Checks out the repository.
2. Installs Python.
3. Installs ingestion dependencies.
4. Retrieves VGSM content.
5. Downloads usable images.
6. Generates `games.json`.
7. Commits changed data and images.

The ingestion process is designed to normalize WordPress responsive image
variants so that URLs such as:

```text
image.jpg
image-300x200.jpg
image-768x512.jpg
image-1536x1024.jpg
```

represent the same logical image rather than several different images.

Images are also checked to make sure they are actually valid image files.

---

## Generated data

`app/data/games.json` is generated data.

Do not manually edit it unless you are intentionally debugging the generated
schema.

The general structure is:

```json
{
  "schema_version": 1,
  "source": {
    "name": "Video Game Soda Machine Project",
    "url": "https://vgsmproject.com"
  },
  "games": [
    {
      "id": "wp-10243",
      "name": "Epic Skater 2",
      "normalized_name": "epic skater 2",
      "aliases": [],
      "series": null,
      "accept": [
        "epic skater 2"
      ],
      "partial": [],
      "article": "...",
      "source": {
        "site": "vgsm",
        "url": "...",
        "post_id": 10243,
        "date": "..."
      },
      "categories": [],
      "tags": [],
      "images": [
        {
          "source_url": "...",
          "path": "assets/images/wp-10243-1.jpg",
          "alt": "...",
          "width": 1200,
          "height": 800
        }
      ]
    }
  ]
}
```

The schema is intentionally richer than what the current game needs.

That gives us room to improve answer matching and other game features without
having to redesign the ingestion layer.

---

## Guess matching

Guess matching is deliberately more flexible than a simple string equality
check.

The game normalizes guesses by:

- Converting to lowercase
- Removing accents
- Converting `&` to `and`
- Removing punctuation
- Normalizing whitespace

Matching can then identify:

- Exact titles
- Meaningful title overlap
- Strong prefix matches
- Reasonable typo matches

Short words are treated conservatively to avoid false positives.

For example, a short guess such as `Reel` should not accidentally match
`Pokémon FireRed` simply because the strings happen to contain similar
characters.

The goal is to make the game forgiving without making almost any guess count
as a match.

---

## Daily puzzles

The daily game is deterministic.

A shared epoch is used to select the daily puzzle, meaning players see the
same puzzle on the same date.

The game stores daily progress in browser local storage so refreshing the page
does not lose an in-progress game.

---

## Free Play

Free Play selects a random puzzle from the catalog.

It is intended for:

- Playing additional puzzles
- Testing new content
- Trying to identify games without waiting for the daily puzzle

The game avoids immediately selecting the same puzzle when another puzzle is
available.

---

## Reporting a puzzle problem

If a puzzle appears to have a problem, please use the **Report a Puzzle
Issue** button in the game.

The report form is designed to include the puzzle's canonical ID and source
page automatically.

This is particularly useful for image problems.

For example:

> Puzzle `wp-10243` displays an image that belongs to a different game.

The important piece of information is the puzzle ID:

```text
wp-10243
```

This allows the issue to be traced directly back to the VGSM source record.

### Typical reports

Please report things like:

- 🖼️ Wrong image
- 🖼️ Broken image
- 🖼️ Missing image
- 🎮 Wrong game associated with an image
- 📝 Incorrect game title
- 🔗 Incorrect VGSM source
- 🔁 Duplicate content
- Other puzzle-specific problems

---

## Contributing

Pull requests and issue reports are welcome.

For code changes:

1. Fork the repository.
2. Create a branch.
3. Make your change.
4. Test locally.
5. Open a pull request.

For catalog problems, please use the puzzle issue form whenever possible.

### Keep changes focused

This project intentionally favors small, understandable changes over a
large framework.

If something can be solved with ordinary HTML, CSS, and JavaScript, prefer
that over adding a dependency.

---

## Design principles

### Static first

The game should remain deployable as a collection of static files.

### Local first

Game state belongs in the browser whenever possible.

### Simple dependencies

Avoid introducing frameworks or services unless they solve a real problem.

### Source-aware

Every puzzle should be traceable back to its source record.

### Accessible

The game should work with:

- Keyboard input
- Touch devices
- Mobile browsers
- Screen readers where practical

### Friendly error reporting

When something is wrong, contributors should be able to identify the exact
source record without having to reverse-engineer the puzzle.

---

## License

The Pop Quiz application code is open source.

The game data and images originate from the
[Video Game Soda Machine Project](https://vgsmproject.com/) and remain subject
to their respective source rights and terms.

Please respect the rights of the original content creators and the VGSM
project when reusing the generated data or images.

---

## Acknowledgements

Huge thanks to the maintainers of the
[Video Game Soda Machine Project](https://vgsmproject.com/)
for building and maintaining the underlying catalog.

Pop Quiz would not exist without that collection.
