const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PATH_PREFIXES = ["embed", "shorts", "v", "live"];

function parseVideoId(raw) {
    const input = raw.trim();
    if (!input) return null;
    if (VIDEO_ID.test(input)) return input;

    let url;
    try {
        url = new URL(input.includes("://") ? input : "https://" + input);
    } catch {
        return null;
    }

    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const segments = url.pathname.split("/").filter(Boolean);

    if (host === "youtu.be") {
        return VIDEO_ID.test(segments[0]) ? segments[0] : null;
    }

    if (host === "youtube.com" || host === "m.youtube.com") {
        const v = url.searchParams.get("v");
        if (v && VIDEO_ID.test(v)) return v;
        if (PATH_PREFIXES.includes(segments[0]) && VIDEO_ID.test(segments[1])) {
            return segments[1];
        }
    }

    return null;
}

const tbody = document.getElementById("places-body");

for (const place of PLACES) {
    const row = document.createElement("tr");
    row.dataset.id = place.id;

    const columns = [
        ["cell-name", place.name],
        ["cell-quote", place.quote],
        ["tag", place.source],
        ["cell-coord", place.lat],
        ["cell-coord", place.lon],
        ["cell-addr", place.address]
    ];

    for (const [kind, text] of columns) {
        const cell = document.createElement("td");
        if (kind === "tag") {
            const tag = document.createElement("span");
            tag.className = "tag " + text;
            tag.textContent = text;
            cell.appendChild(tag);
        } else {
            cell.className = kind;
            cell.textContent = text;
        }
        row.appendChild(cell);
    }

    tbody.appendChild(row);
}

const linked = [...document.querySelectorAll(".pin"), ...tbody.querySelectorAll("tr")];

function highlight(id, on) {
    for (const el of linked) {
        if (el.dataset.id === id) el.classList.toggle("on", on);
    }
}

for (const el of linked) {
    el.addEventListener("mouseenter", () => highlight(el.dataset.id, true));
    el.addEventListener("mouseleave", () => highlight(el.dataset.id, false));
    el.addEventListener("focus", () => highlight(el.dataset.id, true));
    el.addEventListener("blur", () => highlight(el.dataset.id, false));
}

const form = document.getElementById("video-form");
const input = document.getElementById("video-url");
const error = document.getElementById("error");
const result = document.getElementById("result");
const thumb = document.getElementById("thumb");
const outId = document.getElementById("out-id");
const outLink = document.getElementById("out-link");

form.addEventListener("submit", (event) => {
    event.preventDefault();
    const id = parseVideoId(input.value);

    if (!id) {
        error.textContent = "That is not a YouTube video URL or an 11-character video ID.";
        error.hidden = false;
        result.hidden = true;
        return;
    }

    const watchUrl = "https://www.youtube.com/watch?v=" + id;
    thumb.src = "https://img.youtube.com/vi/" + id + "/hqdefault.jpg";
    thumb.alt = "Thumbnail for video " + id;
    outId.textContent = id;
    outLink.textContent = watchUrl;
    outLink.href = watchUrl;

    error.hidden = true;
    result.hidden = false;
});

form.requestSubmit();
