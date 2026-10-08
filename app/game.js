const MAX_GUESSES = 6;
const STORAGE_PREFIX = "pop-quiz-v2";
const DAILY_EPOCH = "2026-10-06";
const GITHUB_ISSUE_URL =
  "https://github.com/sedward5/soda-guesser/issues/new";

const elements = {
  canvas: document.querySelector("#game-canvas"),
  imagePlaceholder: document.querySelector("#image-placeholder"),
  form: document.querySelector("#guess-form"),
  input: document.querySelector("#guess-input"),
  button: document.querySelector("#guess-button"),
  message: document.querySelector("#game-message"),
  guesses: document.querySelector("#guesses"),
  progress: document.querySelector("#progress"),
  clarity: document.querySelector("#clarity"),
  result: document.querySelector("#result"),
  resultKicker: document.querySelector("#result-kicker"),
  resultTitle: document.querySelector("#result-title"),
  resultDetail: document.querySelector("#result-detail"),
  share: document.querySelector("#share-button"),
  date: document.querySelector("#puzzle-date"),
  helpButton: document.querySelector("#help-button"),
  helpDialog: document.querySelector("#help-dialog"),
  closeHelp: document.querySelector("#close-help"),
  reportButton: document.querySelector("#report-button"),
  reportDialog: document.querySelector("#report-dialog"),
  closeReport: document.querySelector("#close-report"),
  reportPuzzleId: document.querySelector("#report-puzzle-id"),
  reportIssueLink: document.querySelector("#report-issue-link"),
  freePlay: document.querySelector("#free-play"),
  modeLabel: document.querySelector("#mode-label"),
  suggestions: document.querySelector("#suggestions"),
};

const ctx = elements.canvas.getContext("2d");

let games = [];
let puzzle = null;
let sourceImage = null;
let guesses = [];
let finished = false;
let won = false;
let mode = "daily";
let suggestionNames = [];


/* -------------------------------------------------------------------------- */
/* Utility                                                                     */
/* -------------------------------------------------------------------------- */

function decodeHtmlEntities(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const textarea = document.createElement("textarea");
  textarea.innerHTML = String(value);
  return textarea.value;
}


function displayGameName(game) {
  return decodeHtmlEntities(game?.name || "");
}


function normalize(value) {
  return decodeHtmlEntities(String(value ?? ""))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}


function normalizedTokens(value) {
  return normalize(value).split(" ").filter(Boolean);
}


function compactCharacters(value) {
  return normalize(value).replace(/\s/g, "");
}


function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


/* -------------------------------------------------------------------------- */
/* Game matching                                                               */
/* -------------------------------------------------------------------------- */

function answerNames(game) {
  return [
    game.name,
    ...(game.aliases || []),
    ...(game.accept || []),
  ]
    .map(normalize)
    .filter(Boolean);
}


function findGameForGuess(value) {
  const normalized = normalize(value);

  if (!normalized) {
    return null;
  }

  // Prefer an exact match against the actual catalog title.
  const exactName = games.find(
    (game) => normalize(game.name) === normalized,
  );

  if (exactName) {
    return exactName;
  }

  // Then allow aliases / accepted names.
  return (
    games.find((game) => answerNames(game).includes(normalized)) ||
    null
  );
}


function sourceUrlForGame(game) {
  const url = game?.source?.url;

  if (
    typeof url !== "string" ||
    !/^https?:\/\//i.test(url)
  ) {
    return null;
  }

  return url;
}


function createExternalLinkIcon() {
  const svg = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "svg",
  );

  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("external-link-icon");

  const box = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "path",
  );

  box.setAttribute(
    "d",
    "M5 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V11",
  );

  const arrow = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "path",
  );

  arrow.setAttribute(
    "d",
    "M9 2h5v5M14 2 7 9",
  );

  svg.append(box, arrow);

  return svg;
}


function createSourceLink(
  game,
  className = "game-source-link",
) {
  const url = sourceUrlForGame(game);

  if (!url) {
    return null;
  }

  const link = document.createElement("a");

  link.className = className;
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.title =
    "View this game on the Video Game Soda Machine Project";
  link.setAttribute(
    "aria-label",
    `View ${displayGameName(game)} on the Video Game Soda Machine Project`,
  );

  link.append(createExternalLinkIcon());

  return link;
}


function renderResultTitle(game) {
  elements.resultTitle.replaceChildren();

  const name = document.createTextNode(
    displayGameName(game),
  );

  elements.resultTitle.append(name);

  const sourceLink = createSourceLink(
    game,
    "result-source-link",
  );

  if (sourceLink) {
    elements.resultTitle.append(
      document.createTextNode(" "),
      sourceLink,
    );
  }
}


/* -------------------------------------------------------------------------- */
/* Guess scoring                                                               */
/* -------------------------------------------------------------------------- */

function guessStatus(value) {
  const guess = normalize(value);
  const names = answerNames(puzzle);

  if (names.includes(guess)) {
    return "exact";
  }

  const guessCompact = compactCharacters(value);

  if (!guessCompact) {
    return "wrong";
  }

  for (const answer of names) {
    const answerCompact = compactCharacters(answer);

    if (
      answerCompact.includes(guessCompact) ||
      guessCompact.includes(answerCompact)
    ) {
      return "partial";
    }

    const guessTokens = normalizedTokens(value);
    const answerTokens = normalizedTokens(answer);

    if (
      guessTokens.some((token) =>
        answerTokens.includes(token),
      )
    ) {
      return "partial";
    }
  }

  return "wrong";
}


function statusLabel(status) {
  switch (status) {
    case "exact":
      return "Correct";

    case "partial":
      return "Close";

    default:
      return "Wrong";
  }
}


function statusDetail(status) {
  switch (status) {
    case "exact":
      return "Exact match";

    case "partial":
      return "Possible match";

    default:
      return "Not a match";
  }
}


/* -------------------------------------------------------------------------- */
/* Daily puzzle                                                                */
/* -------------------------------------------------------------------------- */

function dateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}


function daysBetween(startDate, endDate) {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);

  return Math.floor((end - start) / 86400000);
}


function dailyPuzzleIndex(date = new Date()) {
  const days = Math.max(
    0,
    daysBetween(DAILY_EPOCH, dateKey(date)),
  );

  return games.length
    ? days % games.length
    : 0;
}


function getDailyPuzzle() {
  return games[dailyPuzzleIndex()];
}


function getRandomPuzzle() {
  if (!games.length) {
    return null;
  }

  return games[
    Math.floor(Math.random() * games.length)
  ];
}


/* -------------------------------------------------------------------------- */
/* Storage                                                                     */
/* -------------------------------------------------------------------------- */

function storageKey() {
  if (mode === "free") {
    return `${STORAGE_PREFIX}:free`;
  }

  return `${STORAGE_PREFIX}:${dateKey()}`;
}


function loadState() {
  try {
    const raw = localStorage.getItem(storageKey());

    if (!raw) {
      return null;
    }

    const saved = JSON.parse(raw);

    if (!saved || typeof saved !== "object") {
      return null;
    }

    return {
      puzzleId: saved.puzzleId || null,
      guesses: Array.isArray(saved.guesses)
        ? saved.guesses.map(decodeHtmlEntities)
        : [],
      finished: Boolean(saved.finished),
      won: Boolean(saved.won),
    };
  } catch {
    return null;
  }
}


function saveState() {
  try {
    localStorage.setItem(
      storageKey(),
      JSON.stringify({
        puzzleId: puzzle?.id || null,
        guesses,
        finished,
        won,
      }),
    );
  } catch {
    // Local storage may be unavailable.
  }
}


/* -------------------------------------------------------------------------- */
/* Statistics                                                                  */
/* -------------------------------------------------------------------------- */

function statsStorageKey() {
  return `${STORAGE_PREFIX}:stats`;
}


function loadStats() {
  try {
    const raw = localStorage.getItem(statsStorageKey());

    if (!raw) {
      return {};
    }

    const stats = JSON.parse(raw);

    return stats && typeof stats === "object"
      ? stats
      : {};
  } catch {
    return {};
  }
}


function saveStats(stats) {
  try {
    localStorage.setItem(
      statsStorageKey(),
      JSON.stringify(stats),
    );
  } catch {
    // Ignore storage failures.
  }
}


function recordDailyResult(success, guessCount) {
  const stats = loadStats();
  const today = dateKey();

  // Never overwrite an existing daily result.
  if (stats[today]) {
    return;
  }

  stats[today] = {
    won: Boolean(success),
    guesses: success ? guessCount : null,
  };

  saveStats(stats);
}


function completedDailyResults() {
  const stats = loadStats();

  return Object.entries(stats)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, result]) => ({
      date,
      ...result,
    }));
}


function calculateStats() {
  const results = completedDailyResults();

  const played = results.length;
  const wins = results.filter(
    (result) => result.won,
  ).length;

  let currentStreak = 0;
  let bestStreak = 0;
  let streak = 0;

  const distribution = [
    0,
    0,
    0,
    0,
    0,
    0,
  ];

  for (const result of results) {
    if (result.won) {
      streak += 1;
      bestStreak = Math.max(bestStreak, streak);

      if (
        Number.isInteger(result.guesses) &&
        result.guesses >= 1 &&
        result.guesses <= MAX_GUESSES
      ) {
        distribution[result.guesses - 1] += 1;
      }
    } else {
      streak = 0;
    }
  }

  const today = dateKey();

  if (results.length) {
    const lastResult =
      results[results.length - 1];

    if (
      lastResult.date === today &&
      lastResult.won
    ) {
      currentStreak = streak;
    } else {
      const yesterday = new Date(
        `${today}T00:00:00Z`,
      );

      yesterday.setUTCDate(
        yesterday.getUTCDate() - 1,
      );

      const yesterdayKey = dateKey(yesterday);

      if (
        lastResult.date === yesterdayKey &&
        lastResult.won
      ) {
        currentStreak = streak;
      }
    }
  }

  return {
    played,
    wins,
    winRate: played
      ? Math.round((wins / played) * 100)
      : 0,
    currentStreak,
    bestStreak,
    distribution,
  };
}


function createStatsUI() {
  const headerActions =
    document.querySelector(".header-actions");

  if (
    !headerActions ||
    document.querySelector("#stats-button")
  ) {
    return;
  }

  const statsButton =
    document.createElement("button");

  statsButton.className = "icon-button";
  statsButton.id = "stats-button";
  statsButton.type = "button";
  statsButton.textContent = "▥";
  statsButton.setAttribute(
    "aria-label",
    "Statistics",
  );
  statsButton.title = "Statistics";

  const dialog = document.createElement("dialog");

  dialog.id = "stats-dialog";
  dialog.className = "game-dialog";

  dialog.innerHTML = `
    <div class="dialog-content">
      <div class="dialog-header">
        <div>
          <p class="eyebrow">Your stats</p>
          <h2>Daily progress</h2>
        </div>

        <button
          class="dialog-close"
          id="close-stats"
          type="button"
          aria-label="Close statistics"
        >×</button>
      </div>

      <div id="stats-content"></div>
    </div>
  `;

  document.body.append(dialog);

  const closeButton =
    dialog.querySelector("#close-stats");

  statsButton.addEventListener("click", () => {
    renderStats();
    dialog.showModal();
  });

  closeButton.addEventListener("click", () => {
    dialog.close();
  });

  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      dialog.close();
    }
  });

  headerActions.insertBefore(
    statsButton,
    elements.reportButton,
  );
}


function renderStats() {
  const container =
    document.querySelector("#stats-content");

  if (!container) {
    return;
  }

  const stats = calculateStats();

  const maxDistribution = Math.max(
    1,
    ...stats.distribution,
  );

  container.innerHTML = `
    <div class="stats-summary">
      <div class="stats-stat">
        <strong>${stats.played}</strong>
        <span>Played</span>
      </div>

      <div class="stats-stat">
        <strong>${stats.winRate}%</strong>
        <span>Win rate</span>
      </div>

      <div class="stats-stat">
        <strong>${stats.currentStreak}</strong>
        <span>Current streak</span>
      </div>

      <div class="stats-stat">
        <strong>${stats.bestStreak}</strong>
        <span>Best streak</span>
      </div>
    </div>

    <h3>Guess distribution</h3>

    <div class="stats-distribution">
      ${stats.distribution
        .map(
          (count, index) => `
            <div class="stats-distribution-row">
              <span>${index + 1}</span>

              <div class="stats-bar-track">
                <div
                  class="stats-bar"
                  style="width: ${
                    (count / maxDistribution) * 100
                  }%"
                >${count}</div>
              </div>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}


/* -------------------------------------------------------------------------- */
/* Image rendering                                                             */
/* -------------------------------------------------------------------------- */

function imagePath(image) {
  return image?.path || "";
}


function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();

    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}


function setImagePlaceholderVisible(visible) {
  if (!elements.imagePlaceholder) {
    return;
  }

  elements.imagePlaceholder.hidden = !visible;
}


function calculatePixelSize() {
  if (guesses.length === 0) {
    return 48;
  }

  if (guesses.length === 1) {
    return 32;
  }

  if (guesses.length === 2) {
    return 24;
  }

  if (guesses.length === 3) {
    return 16;
  }

  if (guesses.length === 4) {
    return 10;
  }

  return 4;
}


function drawPuzzleImage() {
  if (!sourceImage) {
    return;
  }

  const width =
    elements.canvas.clientWidth || 800;

  const height =
    elements.canvas.clientHeight ||
    Math.round(width * 0.65);

  elements.canvas.width = width;
  elements.canvas.height = height;

  ctx.clearRect(
    0,
    0,
    elements.canvas.width,
    elements.canvas.height,
  );

  const imageRatio =
    sourceImage.width / sourceImage.height;

  const canvasRatio = width / height;

  let drawWidth;
  let drawHeight;
  let offsetX;
  let offsetY;

  if (imageRatio > canvasRatio) {
    drawHeight = height;
    drawWidth = height * imageRatio;
    offsetX = (width - drawWidth) / 2;
    offsetY = 0;
  } else {
    drawWidth = width;
    drawHeight = width / imageRatio;
    offsetX = 0;
    offsetY = (height - drawHeight) / 2;
  }

  const pixelSize = calculatePixelSize();

  if (pixelSize <= 1) {
    ctx.drawImage(
      sourceImage,
      offsetX,
      offsetY,
      drawWidth,
      drawHeight,
    );

    return;
  }

  const smallWidth = Math.max(
    1,
    Math.ceil(drawWidth / pixelSize),
  );

  const smallHeight = Math.max(
    1,
    Math.ceil(drawHeight / pixelSize),
  );

  const offscreen =
    document.createElement("canvas");

  offscreen.width = smallWidth;
  offscreen.height = smallHeight;

  const offscreenCtx =
    offscreen.getContext("2d");

  offscreenCtx.imageSmoothingEnabled = false;

  offscreenCtx.drawImage(
    sourceImage,
    0,
    0,
    smallWidth,
    smallHeight,
  );

  ctx.imageSmoothingEnabled = false;

  ctx.drawImage(
    offscreen,
    offsetX,
    offsetY,
    drawWidth,
    drawHeight,
  );
}


/* -------------------------------------------------------------------------- */
/* Guess rendering                                                             */
/* -------------------------------------------------------------------------- */

function renderGuesses() {
  elements.guesses.replaceChildren();

  for (
    let index = 0;
    index < MAX_GUESSES;
    index += 1
  ) {
    const row = document.createElement("div");

    row.className = "guess-row";

    const number =
      document.createElement("span");

    number.className = "guess-number";
    number.textContent = String(index + 1);

    if (index >= guesses.length) {
      row.classList.add("empty");

      const name =
        document.createElement("span");

      name.className = "guess-name";

      const statusElement =
        document.createElement("span");

      statusElement.className =
        "guess-status";

      row.append(
        number,
        name,
        statusElement,
      );

      elements.guesses.append(row);

      continue;
    }

    const guess = decodeHtmlEntities(
      guesses[index],
    );

    const status = guessStatus(guess);

    const name =
      document.createElement("span");

    name.className = "guess-name";

    name.append(
      document.createTextNode(guess),
    );

    const matchedGame =
      findGameForGuess(guess);

    const sourceLink = createSourceLink(
      matchedGame,
      "guess-source-link",
    );

    if (sourceLink) {
      name.append(
        document.createTextNode(" "),
        sourceLink,
      );
    }

    const statusElement =
      document.createElement("span");

    statusElement.className =
      `guess-status ${status}`;

    const statusName =
      document.createElement("strong");

    statusName.textContent =
      statusLabel(status);

    const statusDescription =
      document.createElement("small");

    statusDescription.textContent =
      statusDetail(status);

    statusElement.append(
      statusName,
      statusDescription,
    );

    row.append(
      number,
      name,
      statusElement,
    );

    elements.guesses.append(row);
  }
}


/* -------------------------------------------------------------------------- */
/* Suggestions                                                                 */
/* -------------------------------------------------------------------------- */

function populateSuggestions() {
  const names = games
    .map(displayGameName)
    .filter(Boolean);

  suggestionNames = [
    ...new Map(
      names.map((name) => [
        normalize(name),
        name,
      ]),
    ).values(),
  ];
}


function hideSuggestions() {
  elements.suggestions.hidden = true;
  elements.suggestions.replaceChildren();
}


function showSuggestions(value) {
  const normalized = normalize(value);

  if (normalized.length < 3) {
    hideSuggestions();
    return;
  }

  const matches = suggestionNames
    .filter((name) =>
      normalize(name).includes(normalized),
    )
    .slice(0, 8);

  if (!matches.length) {
    hideSuggestions();
    return;
  }

  elements.suggestions.replaceChildren();

  for (const name of matches) {
    const option =
      document.createElement("button");

    option.type = "button";
    option.className = "suggestion";
    option.textContent = name;

    option.addEventListener("click", () => {
      elements.input.value = name;
      hideSuggestions();
      elements.input.focus();
    });

    elements.suggestions.append(option);
  }

  elements.suggestions.hidden = false;
}


/* -------------------------------------------------------------------------- */
/* Progress / messaging                                                        */
/* -------------------------------------------------------------------------- */

function updateProgress() {
  elements.progress.textContent =
    `${guesses.length} / ${MAX_GUESSES}`;

  const remaining = Math.max(
    0,
    MAX_GUESSES - guesses.length,
  );

  elements.clarity.textContent =
    remaining === MAX_GUESSES
      ? "Very blurry"
      : remaining === 0
        ? "Fully revealed"
        : `${remaining} guess${
            remaining === 1 ? "" : "es"
          } remaining`;
}


function setMessage(message, type = "") {
  elements.message.textContent = message;
  elements.message.className = "game-message";

  if (type) {
    elements.message.classList.add(type);
  }
}


/* -------------------------------------------------------------------------- */
/* Game lifecycle                                                              */
/* -------------------------------------------------------------------------- */

async function startPuzzle(nextPuzzle) {
  puzzle = nextPuzzle;
  sourceImage = null;
  guesses = [];
  finished = false;
  won = false;

  elements.result.hidden = true;
  elements.form.hidden = false;
  elements.input.disabled = false;
  elements.button.disabled = false;
  elements.input.value = "";

  setImagePlaceholderVisible(true);

  hideSuggestions();

  renderGuesses();
  updateProgress();

  setMessage("");

  if (mode === "daily") {
    elements.modeLabel.textContent =
      "Daily puzzle";

    elements.date.textContent =
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "long",
      }).format(new Date());
  } else {
    elements.modeLabel.textContent =
      "Free play";

    elements.date.textContent =
      "Random puzzle";
  }

  const image = puzzle?.images?.[0];

  if (!image) {
    setImagePlaceholderVisible(false);

    setMessage(
      "This puzzle does not have an image yet.",
      "error",
    );

    return;
  }

  try {
    sourceImage = await loadImage(
      imagePath(image),
    );

    drawPuzzleImage();
    setImagePlaceholderVisible(false);
  } catch {
    setImagePlaceholderVisible(false);

    setMessage(
      "The puzzle image could not be loaded.",
      "error",
    );
  }
}


function finishGame(success) {
  finished = true;
  won = success;

  elements.input.disabled = true;
  elements.button.disabled = true;

  hideSuggestions();

  if (success) {
    elements.resultKicker.textContent =
      "Nice one";

    renderResultTitle(puzzle);

    elements.resultDetail.textContent =
      `You got it in ${guesses.length} ${
        guesses.length === 1
          ? "guess"
          : "guesses"
      }.`;

    if (mode === "daily") {
      recordDailyResult(
        true,
        guesses.length,
      );
    }
  } else {
    elements.resultKicker.textContent =
      "Better luck next time";

    renderResultTitle(puzzle);

    elements.resultDetail.textContent =
      `The answer was ${displayGameName(puzzle)}.`;

    if (mode === "daily") {
      recordDailyResult(false, null);
    }
  }

  elements.result.hidden = false;

  saveState();
}


/* -------------------------------------------------------------------------- */
/* Guess submission                                                            */
/* -------------------------------------------------------------------------- */

function submitGuess(value) {
  if (finished || !puzzle) {
    return;
  }

  const guess = decodeHtmlEntities(
    String(value ?? "").trim(),
  );

  if (!guess) {
    setMessage(
      "Enter a guess first.",
      "error",
    );

    return;
  }

  const normalizedGuess =
    normalize(guess);

  if (
    guesses.some(
      (existing) =>
        normalize(existing) === normalizedGuess,
    )
  ) {
    setMessage(
      "You already tried that guess.",
      "error",
    );

    return;
  }

  const status = guessStatus(guess);

  guesses.push(guess);

  renderGuesses();
  updateProgress();
  drawPuzzleImage();

  if (status === "exact") {
    setMessage(
      "Correct!",
      "success",
    );

    finishGame(true);

    return;
  }

  if (guesses.length >= MAX_GUESSES) {
    setMessage(
      `The answer was ${displayGameName(puzzle)}.`,
      "error",
    );

    finishGame(false);

    return;
  }

  if (status === "partial") {
    setMessage(
      "Close! You're on the right track.",
      "partial",
    );
  } else {
    setMessage(
      "Nope. The image is a little clearer now.",
    );
  }

  saveState();

  elements.input.value = "";
  elements.input.focus();
}


/* -------------------------------------------------------------------------- */
/* Report issue                                                                */
/* -------------------------------------------------------------------------- */

function updateReportDialog() {
  if (!puzzle) {
    return;
  }

  elements.reportPuzzleId.textContent =
    puzzle.id || "Unknown";

  const params = new URLSearchParams();

  params.set(
    "title",
    `Puzzle issue: ${puzzle.id}`,
  );

  const body = [
    "## Puzzle issue",
    "",
    `Puzzle ID: ${puzzle.id}`,
    `VGSM source: ${
      puzzle.source?.url || "Unknown"
    }`,
    "",
    "### What is wrong?",
    "",
    "<!-- Examples: incorrect image, missing image, broken source post, etc. -->",
    "",
  ].join("\n");

  params.set("body", body);
  params.set("labels", "bug");

  elements.reportIssueLink.href =
    `${GITHUB_ISSUE_URL}?${params.toString()}`;
}


/* -------------------------------------------------------------------------- */
/* Sharing                                                                     */
/* -------------------------------------------------------------------------- */

async function shareResult() {
  if (!puzzle) {
    return;
  }

  const rows = guesses.map((guess) => {
    const status = guessStatus(guess);

    if (status === "exact") {
      return "🟩";
    }

    if (status === "partial") {
      return "🟨";
    }

    return "⬜";
  });

  const resultText = [
    `Pop Quiz — ${
      mode === "daily"
        ? dateKey()
        : "Free Play"
    }`,
    "",
    rows.join(""),
    "",
    won
      ? `${guesses.length}/${MAX_GUESSES}`
      : `X/${MAX_GUESSES}`,
  ].join("\n");

  try {
    if (navigator.share) {
      await navigator.share({
        title: "Pop Quiz",
        text: resultText,
      });

      return;
    }

    await navigator.clipboard.writeText(
      resultText,
    );

    setMessage(
      "Result copied to your clipboard.",
      "success",
    );
  } catch {
    // User cancelled sharing or clipboard access failed.
  }
}


/* -------------------------------------------------------------------------- */
/* Load data                                                                   */
/* -------------------------------------------------------------------------- */

async function loadGames() {
  const response = await fetch(
    "./data/games.json",
    {
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(
      `Unable to load games.json: ${response.status}`,
    );
  }

  const data = await response.json();

  if (!Array.isArray(data.games)) {
    throw new Error(
      "games.json does not contain a games array.",
    );
  }

  games = data.games;

  populateSuggestions();
}


/* -------------------------------------------------------------------------- */
/* Mode handling                                                               */
/* -------------------------------------------------------------------------- */

async function loadGame() {
  const saved = loadState();

  const requestedPuzzle =
    mode === "free"
      ? getRandomPuzzle()
      : getDailyPuzzle();

  if (!requestedPuzzle) {
    setMessage(
      "No puzzles are available yet.",
      "error",
    );

    return;
  }

  await startPuzzle(requestedPuzzle);

  if (
    saved &&
    saved.puzzleId === puzzle.id &&
    Array.isArray(saved.guesses)
  ) {
    guesses =
      saved.guesses.map(decodeHtmlEntities);

    finished = Boolean(saved.finished);
    won = Boolean(saved.won);

    renderGuesses();
    updateProgress();
    drawPuzzleImage();

    if (finished) {
      elements.input.disabled = true;
      elements.button.disabled = true;

      if (won) {
        elements.resultKicker.textContent =
          "Nice one";

        renderResultTitle(puzzle);

        elements.resultDetail.textContent =
          `You got it in ${guesses.length} ${
            guesses.length === 1
              ? "guess"
              : "guesses"
          }.`;
      } else {
        elements.resultKicker.textContent =
          "Better luck next time";

        renderResultTitle(puzzle);

        elements.resultDetail.textContent =
          `The answer was ${displayGameName(puzzle)}.`;
      }

      elements.result.hidden = false;
    }
  }
}


function enterFreePlay() {
  mode = "free";

  // Free play intentionally has no stats.
  loadGame();
}


function enterDaily() {
  mode = "daily";

  loadGame();
}


/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

elements.form.addEventListener(
  "submit",
  (event) => {
    event.preventDefault();

    submitGuess(elements.input.value);
  },
);


elements.input.addEventListener(
  "input",
  () => {
    showSuggestions(
      elements.input.value,
    );
  },
);


elements.input.addEventListener(
  "focus",
  () => {
    showSuggestions(
      elements.input.value,
    );
  },
);


document.addEventListener(
  "click",
  (event) => {
    if (
      !elements.input.contains(event.target) &&
      !elements.suggestions.contains(event.target)
    ) {
      hideSuggestions();
    }
  },
);


elements.helpButton.addEventListener(
  "click",
  () => {
    elements.helpDialog.showModal();
  },
);


elements.closeHelp.addEventListener(
  "click",
  () => {
    elements.helpDialog.close();
  },
);


elements.helpDialog.addEventListener(
  "click",
  (event) => {
    if (event.target === elements.helpDialog) {
      elements.helpDialog.close();
    }
  },
);


elements.reportButton.addEventListener(
  "click",
  () => {
    updateReportDialog();
    elements.reportDialog.showModal();
  },
);


elements.closeReport.addEventListener(
  "click",
  () => {
    elements.reportDialog.close();
  },
);


elements.reportDialog.addEventListener(
  "click",
  (event) => {
    if (
      event.target === elements.reportDialog
    ) {
      elements.reportDialog.close();
    }
  },
);


elements.freePlay.addEventListener(
  "click",
  () => {
    enterFreePlay();
  },
);


elements.share.addEventListener(
  "click",
  () => {
    shareResult();
  },
);


window.addEventListener(
  "resize",
  () => {
    drawPuzzleImage();
  },
);


/* -------------------------------------------------------------------------- */
/* Initialization                                                              */
/* -------------------------------------------------------------------------- */

async function initialize() {
  try {
    await loadGames();

    createStatsUI();

    await loadGame();
  } catch (error) {
    console.error(error);

    setMessage(
      "The game could not load. Try refreshing the page.",
      "error",
    );
  }
}


initialize();
