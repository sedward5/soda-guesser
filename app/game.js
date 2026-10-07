const MAX_GUESSES = 6;
const STORAGE_PREFIX = "pop-quiz-v1";

const elements = {
  canvas: document.querySelector("#game-canvas"),
  imageFrame: document.querySelector("#image-frame"),
  placeholder: document.querySelector("#image-placeholder"),
  form: document.querySelector("#guess-form"),
  input: document.querySelector("#guess-input"),
  button: document.querySelector("#guess-button"),
  message: document.querySelector("#guess-message"),
  guesses: document.querySelector("#guesses"),
  progress: document.querySelector("#progress-label"),
  clarity: document.querySelector("#clarity-label"),
  result: document.querySelector("#result"),
  resultKicker: document.querySelector("#result-kicker"),
  resultTitle: document.querySelector("#result-title"),
  resultDetail: document.querySelector("#result-detail"),
  share: document.querySelector("#share-button"),
  date: document.querySelector("#date-label"),
  help: document.querySelector("#help-button"),
  dialog: document.querySelector("#help-dialog"),
  helpClose: document.querySelector("#help-close"),
};

const ctx = elements.canvas.getContext("2d");

let games = [];
let puzzle = null;
let sourceImage = null;
let guesses = [];
let finished = false;
let won = false;

function normalize(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function seededIndex(seed, count) {
  let hash = 2166136261;

  for (const char of seed) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  hash += hash << 13;
  hash ^= hash >>> 7;
  hash += hash << 3;
  hash ^= hash >>> 17;
  hash += hash << 5;

  return Math.abs(hash) % count;
}

function storageKey() {
  return `${STORAGE_PREFIX}:${localDateKey()}`;
}

function saveState() {
  try {
    localStorage.setItem(
      storageKey(),
      JSON.stringify({
        guesses,
        finished,
        won,
      }),
    );
  } catch {
    // Local storage is optional. The game should still work without it.
  }
}

function loadState() {
  try {
    const saved = JSON.parse(
      localStorage.getItem(storageKey()) || "null",
    );

    if (!saved) return;

    guesses = Array.isArray(saved.guesses)
      ? saved.guesses
      : [];

    finished = Boolean(saved.finished);
    won = Boolean(saved.won);
  } catch {
    // A corrupted local state should never prevent the game from loading.
  }
}

function answerNames(game) {
  return [
    game.name,
    ...(game.aliases || []),
    ...(game.accept || []),
  ].map(normalize);
}

function partialNames(game) {
  return [
    ...(game.partial || []),
  ].map(normalize);
}

function guessStatus(value) {
  const normalized = normalize(value);

  if (answerNames(puzzle).includes(normalized)) {
    return "correct";
  }

  if (partialNames(puzzle).includes(normalized)) {
    return "partial";
  }

  return "wrong";
}

function selectedImage(game) {
  const usable = (game.images || []).filter(
    image => image.path,
  );

  if (!usable.length) return null;

  // Use the first logical image for v1.
  // The schema intentionally supports multiple images.
  return usable[0];
}

function clarityForGuessCount(count) {
  const levels = [
    ["Very pixelated", 10],
    ["Pretty pixelated", 18],
    ["Starting to clear", 28],
    ["Getting clearer", 42],
    ["Almost there", 62],
    ["Clear", 100],
  ];

  return levels[
    Math.min(count, levels.length - 1)
  ];
}

function drawPixelated() {
  if (!sourceImage) return;

  const width =
    elements.canvas.clientWidth || 800;

  const height =
    elements.canvas.clientHeight || 450;

  const dpr = Math.min(
    window.devicePixelRatio || 1,
    2,
  );

  elements.canvas.width =
    Math.round(width * dpr);

  elements.canvas.height =
    Math.round(height * dpr);

  ctx.imageSmoothingEnabled = false;

  ctx.clearRect(
    0,
    0,
    elements.canvas.width,
    elements.canvas.height,
  );

  const sourceRatio =
    sourceImage.naturalWidth /
    sourceImage.naturalHeight;

  const targetRatio =
    width / height;

  let drawWidth = width;
  let drawHeight = height;

  if (sourceRatio > targetRatio) {
    drawHeight = height;
    drawWidth = height * sourceRatio;
  } else {
    drawWidth = width;
    drawHeight = width / sourceRatio;
  }

  const revealPercent =
    clarityForGuessCount(
      guesses.length,
    )[1];

  const minDimension =
    Math.min(drawWidth, drawHeight);

  const blocks = Math.max(
    10,
    Math.round(
      10 +
        (minDimension *
          revealPercent) /
          100,
    ),
  );

  const smallWidth = Math.max(
    8,
    Math.round(
      blocks * sourceRatio,
    ),
  );

  const smallHeight = Math.max(
    8,
    Math.round(blocks),
  );

  const temp =
    document.createElement("canvas");

  temp.width = smallWidth;
  temp.height = smallHeight;

  const tempCtx =
    temp.getContext("2d");

  tempCtx.imageSmoothingEnabled =
    true;

  const cropRatio =
    sourceImage.naturalWidth /
    sourceImage.naturalHeight;

  let sx = 0;
  let sy = 0;
  let sw = sourceImage.naturalWidth;
  let sh = sourceImage.naturalHeight;

  if (cropRatio > targetRatio) {
    sw =
      sourceImage.naturalHeight *
      targetRatio;

    sx =
      (sourceImage.naturalWidth -
        sw) /
      2;
  } else {
    sh =
      sourceImage.naturalWidth /
      targetRatio;

    sy =
      (sourceImage.naturalHeight -
        sh) /
      2;
  }

  tempCtx.drawImage(
    sourceImage,
    sx,
    sy,
    sw,
    sh,
    0,
    0,
    smallWidth,
    smallHeight,
  );

  const scaleX =
    elements.canvas.width /
    smallWidth;

  const scaleY =
    elements.canvas.height /
    smallHeight;

  ctx.drawImage(
    temp,
    0,
    0,
    smallWidth,
    smallHeight,
    0,
    0,
    smallWidth * scaleX,
    smallHeight * scaleY,
  );
}

function statusLabel(status) {
  switch (status) {
    case "correct":
      return "Correct";

    case "partial":
      return "Partial";

    default:
      return "Wrong";
  }
}

function renderGuesses() {
  elements.guesses.innerHTML = "";

  guesses.forEach((guess, index) => {
    const status = guessStatus(guess);

    const row =
      document.createElement("li");

    row.className =
      `guess-row ${status}`;

    row.innerHTML = `
      <span class="guess-name">
        ${escapeHtml(guess)}
      </span>
      <span class="guess-status">
        ${statusLabel(status)}
      </span>
      <span class="attempt">
        ${index + 1}/${MAX_GUESSES}
      </span>
    `;

    elements.guesses.appendChild(row);
  });

  elements.progress.textContent =
    finished
      ? won
        ? `Solved in ${guesses.length}`
        : "Game over"
      : `Guess ${
          guesses.length + 1
        } of ${MAX_GUESSES}`;

  elements.clarity.textContent =
    clarityForGuessCount(
      guesses.length,
    )[0];
}

function escapeHtml(value) {
  const div =
    document.createElement("div");

  div.textContent = value;

  return div.innerHTML;
}

function setMessage(
  message,
  isError = false,
) {
  elements.message.textContent =
    message;

  elements.message.classList.toggle(
    "error",
    isError,
  );
}

function flash(
  element,
  className,
) {
  if (!element) return;

  element.classList.remove(
    className,
  );

  void element.offsetWidth;

  element.classList.add(
    className,
  );
}

function finishGame(success) {
  finished = true;
  won = success;

  elements.input.disabled = true;
  elements.button.disabled = true;

  elements.result.hidden = false;
  elements.result.classList.add("pop");

  if (success) {
    elements.resultKicker.textContent =
      "Nice one";

    elements.resultTitle.textContent =
      puzzle.name;

    elements.resultDetail.textContent =
      `You got it in ${
        guesses.length
      } ${
        guesses.length === 1
          ? "guess"
          : "guesses"
      }.`;

    setMessage("🟩 Correct!");
  } else {
    elements.resultKicker.textContent =
      "Better luck tomorrow";

    elements.resultTitle.textContent =
      puzzle.name;

    elements.resultDetail.textContent =
      `The answer was ${puzzle.name}.`;

    setMessage(
      "⬜ No more guesses.",
    );
  }

  saveState();
  renderGuesses();
}

function submitGuess(value) {
  const guess = value.trim();

  if (!guess || finished) return;

  const normalized =
    normalize(guess);

  if (
    guesses.some(
      existing =>
        normalize(existing) ===
        normalized,
    )
  ) {
    setMessage(
      "You already tried that.",
      true,
    );

    flash(
      elements.input,
      "shake",
    );

    return;
  }

  const status =
    guessStatus(guess);

  guesses.push(guess);

  elements.input.value = "";

  // Update the image and feedback together so
  // the player gets an immediate result.
  drawPixelated();
  renderGuesses();

  const latestRow =
    elements.guesses.lastElementChild;

  flash(latestRow, "pop");

  if (status === "correct") {
    finishGame(true);
    return;
  }

  if (status === "partial") {
    setMessage(
      "🟨 Close! You're in the right neighborhood.",
    );
  } else {
    setMessage(
      "⬜ Nope. The picture just got a little clearer.",
    );
  }

  if (guesses.length >= MAX_GUESSES) {
    finishGame(false);
    return;
  }

  saveState();
  elements.input.focus();
}

function shareResult() {
  const blocks =
    guesses
      .map(guess => {
        switch (
          guessStatus(guess)
        ) {
          case "correct":
            return "🟩";

          case "partial":
            return "🟨";

          default:
            return "⬜";
        }
      })
      .join("");

  const text =
    `Pop Quiz ${localDateKey()}\n` +
    `${blocks}\n` +
    `${
      won
        ? `${guesses.length}/6`
        : "X/6"
    }\n` +
    "https://sedward5.github.io/soda-guesser/";

  if (navigator.share) {
    navigator
      .share({
        title: "Pop Quiz",
        text,
      })
      .catch(() => {});

    return;
  }

  navigator.clipboard
    ?.writeText(text)
    .then(() => {
      setMessage(
        "Result copied to your clipboard.",
      );
    })
    .catch(() => {
      setMessage(text);
    });
}

function loadImage(path) {
  return new Promise(
    (resolve, reject) => {
      const image =
        new Image();

      image.onload = () => {
        resolve(image);
      };

      image.onerror = () => {
        reject(
          new Error(
            `Could not load image: ${path}`,
          ),
        );
      };

      image.src = path;
    },
  );
}

async function loadGame() {
  try {
    setMessage(
      "Loading today's game…",
    );

    const response =
      await fetch(
        "data/games.json",
        {
          cache: "no-store",
        },
      );

    if (!response.ok) {
      throw new Error(
        `Could not load game data (HTTP ${response.status}).`,
      );
    }

    const data =
      await response.json();

    games =
      Array.isArray(data.games)
        ? data.games
        : [];

    if (!games.length) {
      throw new Error(
        "No games were found in the dataset.",
      );
    }

    const key =
      localDateKey();

    puzzle =
      games[
        seededIndex(
          key,
          games.length,
        )
      ];

    const image =
      selectedImage(puzzle);

    if (!image) {
      throw new Error(
        "Today's game has no usable image.",
      );
    }

    // Load saved state BEFORE rendering.
    loadState();

    sourceImage =
      await loadImage(
        image.path,
      );

    elements.placeholder.hidden =
      true;

    elements.date.textContent =
      localDateKey();

    drawPixelated();
    renderGuesses();

    if (finished) {
      elements.result.hidden =
        false;

      elements.resultKicker.textContent =
        won
          ? "Already solved"
          : "Today's answer";

      elements.resultTitle.textContent =
        puzzle.name;

      elements.resultDetail.textContent =
        won
          ? `You solved it in ${
              guesses.length
            } ${
              guesses.length === 1
                ? "guess"
                : "guesses"
            }.`
          : "Come back tomorrow for a new game.";
    } else {
      setMessage(
        "What game is this?",
      );

      elements.input.focus();
    }
  } catch (error) {
    console.error(
      "Pop Quiz failed to load:",
      error,
    );

    elements.placeholder.hidden =
      false;

    elements.placeholder.textContent =
      "Couldn't load today's game.";

    setMessage(
      "Try refreshing the page.",
      true,
    );
  }
}

elements.form.addEventListener(
  "submit",
  event => {
    event.preventDefault();

    submitGuess(
      elements.input.value,
    );
  },
);

elements.share.addEventListener(
  "click",
  shareResult,
);

elements.help.addEventListener(
  "click",
  () =>
    elements.dialog.showModal(),
);

elements.helpClose.addEventListener(
  "click",
  () =>
    elements.dialog.close(),
);

elements.dialog.addEventListener(
  "click",
  event => {
    if (
      event.target ===
      elements.dialog
    ) {
      elements.dialog.close();
    }
  },
);

window.addEventListener(
  "resize",
  () => {
    window.requestAnimationFrame(
      drawPixelated,
    );
  },
);

loadGame();
