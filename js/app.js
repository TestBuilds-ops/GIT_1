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

const form = document.getElementById("video-form");
const input = document.getElementById("video-url");
const error = document.getElementById("error");
const result = document.getElementById("result");
const next = document.getElementById("next");
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
        next.hidden = true;
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
    next.hidden = false;
});

form.requestSubmit();
