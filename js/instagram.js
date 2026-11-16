const INSTAGRAM_HOSTS = ["instagram.com", "m.instagram.com", "instagr.am"];
const MEDIA_SEGMENTS = { p: "post", reel: "reel", reels: "reel", tv: "video" };
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
// Nominatim's usage policy allows at most one request per second.
const GEOCODE_GAP_MS = 1100;
// Places are searched for inside this box around the hotel (in degrees, about
// 55 km), and a match from anywhere else is kept only within MAX_PLACE_KM.
const NEARBY_DEGREES = 0.5;
const MAX_PLACE_KM = 150;
const STORAGE_KEY = "stay-map-inputs";

// Turns an Instagram link into what it tells us about a place. Location links
// carry the place's name in their slug; posts, reels and profiles carry none.
function parseInstagram(raw) {
    const input = raw.trim();
    if (!input) return null;

    let url;
    try {
        url = new URL(input.includes("://") ? input : "https://" + input);
    } catch {
        return null;
    }

    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (!INSTAGRAM_HOSTS.includes(host)) return null;

    const segments = url.pathname.split("/").filter(Boolean);
    const href = "https://www.instagram.com/" + segments.join("/") + (segments.length ? "/" : "");

    if (segments[0] === "explore" && segments[1] === "locations" && /^\d+$/.test(segments[2] || "")) {
        const slug = segments[3] ? decodeURIComponent(segments[3]) : "";
        const place = slug.replace(/[-_]+/g, " ").trim().replace(/(^|\s)\p{Ll}/gu, (c) => c.toUpperCase());
        return { kind: "location", place, href };
    }

    // Media links are /p/CODE/ or, more recently, /username/p/CODE/.
    const mediaAt = segments.findIndex((s) => s in MEDIA_SEGMENTS);
    if (mediaAt !== -1 && segments[mediaAt + 1]) {
        return { kind: MEDIA_SEGMENTS[segments[mediaAt]], place: "", href };
    }

    if (segments.length === 1 && /^[A-Za-z0-9._]{1,30}$/.test(segments[0])) {
        return { kind: "profile", place: "", href };
    }

    return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const geocodeCache = new Map();
let lastGeocodeAt = 0;

function looksLikeWebAddress(text) {
    return /:\/\/|^www\.|instagram\.com|instagr\.am/i.test(text);
}

async function geocode(query, near) {
    const params = new URLSearchParams({ q: query, format: "jsonv2", limit: "1" });
    if (near) {
        const d = NEARBY_DEGREES;
        params.set("viewbox", [near.lon - d, near.lat + d, near.lon + d, near.lat - d].join(","));
        params.set("bounded", "1");
    }
    const key = params.toString();
    if (geocodeCache.has(key)) return geocodeCache.get(key);

    const wait = lastGeocodeAt + GEOCODE_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastGeocodeAt = Date.now();

    const response = await fetch(NOMINATIM + "?" + key, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("The geocoder answered " + response.status + ".");
    const [hit] = await response.json();
    const result = hit
        ? { lat: Number(hit.lat), lon: Number(hit.lon), address: hit.display_name }
        : null;
    geocodeCache.set(key, result);
    return result;
}

// Finds an attraction near the hotel. Names are tried as typed, with
// Centre/Center swapped, and without words that just repeat the hotel's city
// (the search box already covers it). A match outside the box only counts if
// it is still within MAX_PLACE_KM, so a same-named place abroad is never used.
async function findNear(name, hotel) {
    const hotelParts = new Set(hotel.address.toLowerCase().split(/,\s*/));
    const variants = [
        name,
        name.replace(/\bcentre\b/gi, "Center").replace(/\btheatre\b/gi, "Theater"),
        name.replace(/\bcenter\b/gi, "Centre").replace(/\btheater\b/gi, "Theatre"),
        name.split(/\s+/).filter((w) => !hotelParts.has(w.toLowerCase().replace(/[,.]/g, ""))).join(" ")
    ];
    for (const variant of [...new Set(variants)]) {
        if (!variant.trim()) continue;
        const hit = await geocode(variant, hotel);
        if (hit) return hit;
    }
    const anywhere = await geocode(name);
    return anywhere && distanceKm(hotel, anywhere) <= MAX_PLACE_KM ? anywhere : null;
}

function distanceKm(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad;
    const dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
              Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
}

function formatDistance(km) {
    return km < 1 ? Math.round(km * 1000) + " m" : km.toFixed(km < 10 ? 1 : 0) + " km";
}

const form = document.getElementById("stay-form");
const hotelInput = document.getElementById("hotel");
const rows = document.getElementById("link-rows");
const rowTemplate = document.getElementById("row-template");
const addRow = document.getElementById("add-row");
const plotButton = document.getElementById("plot");
const statusLine = document.getElementById("status");
const error = document.getElementById("error");
const mapPanel = document.getElementById("map-panel");
const tablePanel = document.getElementById("table-panel");
const tbody = document.getElementById("places-body");

function appendRow(url = "", place = "") {
    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    row.querySelector(".ig-url").value = url;
    row.querySelector(".ig-place").value = place;
    row.querySelector(".remove").addEventListener("click", () => {
        row.remove();
        if (!rows.children.length) appendRow();
        save();
    });
    rows.appendChild(row);
    return row;
}

function readInputs() {
    return {
        hotel: hotelInput.value.trim(),
        links: [...rows.children].map((row) => ({
            url: row.querySelector(".ig-url").value.trim(),
            place: row.querySelector(".ig-place").value.trim()
        }))
    };
}

function save() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(readInputs()));
    } catch {
        // Storage can be unavailable (private windows); inputs just won't persist.
    }
}

// The homepage's Instagram form arrives here as ?ig=…&place=…&hotel=…; those
// values replace whatever was saved, and the map is plotted straight away.
function restore() {
    const params = new URLSearchParams(location.search);
    if (params.has("ig") || params.has("hotel")) {
        hotelInput.value = params.get("hotel") || "";
        appendRow(params.get("ig") || "", params.get("place") || "");
        history.replaceState(null, "", location.pathname);
        save();
        return true;
    }

    let saved = null;
    try {
        saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch {
        saved = null;
    }
    hotelInput.value = saved?.hotel || "";
    const links = saved?.links?.length ? saved.links : [{ url: "", place: "" }];
    for (const link of links) appendRow(link.url, link.place);
    return false;
}

addRow.addEventListener("click", () => {
    appendRow().querySelector(".ig-url").focus();
});
form.addEventListener("input", save);

let map = null;
let layer = null;
let hotelPoint = null;
let framedBounds = null;

function ensureMap() {
    if (map) return;
    map = L.map("map", { scrollWheelZoom: false, zoomSnap: 0.5 });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    layer = L.layerGroup().addTo(map);

    const Recentre = L.Control.extend({
        options: { position: "topleft" },
        onAdd() {
            const button = L.DomUtil.create("button", "recentre");
            button.type = "button";
            button.textContent = "Centre on hotel";
            L.DomEvent.disableClickPropagation(button);
            button.addEventListener("click", frameOnHotel);
            return button;
        }
    });
    new Recentre().addTo(map);
    map.on("resize", frameOnHotel);
}

// Frames the map with the hotel at its exact centre, zoomed out just far enough
// that every plotted place fits. A box mirrored around the hotel gives the zoom.
function frameOnHotel() {
    if (!map || !hotelPoint) return;
    const center = L.latLng(hotelPoint.lat, hotelPoint.lon);
    if (!framedBounds) {
        map.setView(center, 15);
        return;
    }
    const zoom = Math.min(map.getBoundsZoom(framedBounds, false, L.point(48, 48)), 17);
    map.setView(center, zoom);
}

function pinIcon(className, label) {
    return L.divIcon({
        className: "pin-icon " + className,
        html: "<span>" + label + "</span>",
        iconSize: [28, 28],
        iconAnchor: [14, 14],
        popupAnchor: [0, -14]
    });
}

function popupContent(title, detail) {
    const box = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = title;
    const small = document.createElement("small");
    small.textContent = detail;
    box.append(strong, document.createElement("br"), small);
    return box;
}

function render(hotel, places) {
    ensureMap();
    layer.clearLayers();
    hotelPoint = hotel;

    L.marker([hotel.lat, hotel.lon], {
        icon: pinIcon("hotel", "H"),
        zIndexOffset: 1000,
        title: hotel.name
    }).bindPopup(popupContent(hotel.name, hotel.address)).addTo(layer);

    const located = places.filter((p) => p.point);
    for (const place of located) {
        L.polyline([[hotel.lat, hotel.lon], [place.point.lat, place.point.lon]], {
            className: "spoke",
            interactive: false
        }).addTo(layer);
        L.marker([place.point.lat, place.point.lon], {
            icon: pinIcon("place", String(place.number)),
            title: place.name
        }).bindPopup(popupContent(place.number + ". " + place.name,
            formatDistance(place.km) + " from the hotel")).addTo(layer);
    }

    if (located.length) {
        const dLat = Math.max(...located.map((p) => Math.abs(p.point.lat - hotel.lat)));
        const dLon = Math.max(...located.map((p) => Math.abs(p.point.lon - hotel.lon)));
        framedBounds = L.latLngBounds(
            [hotel.lat - dLat, hotel.lon - dLon],
            [hotel.lat + dLat, hotel.lon + dLon]
        );
    } else {
        framedBounds = null;
    }

    tbody.replaceChildren();
    for (const place of places) {
        const row = document.createElement("tr");
        const cells = [
            String(place.number),
            place.name,
            null,
            place.point ? formatDistance(place.km) : "—",
            place.point ? place.point.address
                : "Not found within " + MAX_PLACE_KM + " km of the hotel — check the spelling or try the local name"
        ];
        cells.forEach((text, i) => {
            const cell = document.createElement("td");
            if (i === 2 && !place.href) {
                cell.textContent = "typed";
            } else if (i === 2) {
                const link = document.createElement("a");
                link.href = place.href;
                link.target = "_blank";
                link.rel = "noopener noreferrer";
                link.textContent = place.kind;
                cell.appendChild(link);
            } else {
                cell.textContent = text;
                cell.className = ["cell-coord", "cell-name", "", "cell-coord", "cell-addr"][i];
                if (i === 4 && !place.point) cell.classList.add("missing");
            }
            row.appendChild(cell);
        });
        tbody.appendChild(row);
    }

    mapPanel.hidden = false;
    tablePanel.hidden = false;
    map.invalidateSize();
    frameOnHotel();
}

function showError(message) {
    error.textContent = message;
    error.hidden = !message;
}

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    showError("");
    const inputs = readInputs();

    if (!inputs.hotel) {
        showError("Enter the hotel so the map has somewhere to centre.");
        hotelInput.focus();
        return;
    }
    if (looksLikeWebAddress(inputs.hotel)) {
        showError("The hotel box needs the hotel's name or street address, not a web address.");
        hotelInput.focus();
        return;
    }

    const places = [];
    const problems = [];
    inputs.links.forEach((link, i) => {
        let { url, place } = link;
        if (!url && !place) return;
        // Pasting the link into the place box is an easy slip; move it across.
        if (!url && looksLikeWebAddress(place)) [url, place] = [place, ""];
        if (looksLikeWebAddress(place)) {
            problems.push("Place name " + (i + 1) + " is a web address. Type the attraction's name instead, " +
                "e.g. “Longgang International Arts Centre”.");
            return;
        }
        // An attraction typed straight into the Instagram box is plotted as typed.
        if (url && !looksLikeWebAddress(url) && !place) {
            places.push({ number: places.length + 1, name: url, kind: "typed", href: null });
            return;
        }
        const parsed = parseInstagram(url);
        if (!parsed) {
            problems.push("Instagram address " + (i + 1) + " isn't a post, reel, profile or location address.");
            return;
        }
        const name = place || parsed.place;
        if (!name) {
            problems.push("Instagram address " + (i + 1) + " is a " + parsed.kind +
                ", which doesn't say where it is. Type the place name next to it.");
            return;
        }
        places.push({ number: places.length + 1, name, kind: parsed.kind, href: parsed.href });
    });

    if (problems.length) {
        showError(problems.join(" "));
        return;
    }

    plotButton.disabled = true;
    try {
        statusLine.textContent = "Finding the hotel…";
        const hotelHit = await geocode(inputs.hotel);
        if (!hotelHit) {
            showError("Couldn't find “" + inputs.hotel + "”. Try adding the city or street address.");
            return;
        }
        const hotel = { ...hotelHit, name: inputs.hotel };

        for (const place of places) {
            statusLine.textContent = "Finding " + place.name + " (" + place.number + " of " + places.length + ")…";
            place.point = await findNear(place.name, hotel);
            if (place.point) place.km = distanceKm(hotel, place.point);
        }

        render(hotel, places);
        const missing = places.filter((p) => !p.point).length;
        if (missing) showError(missing + " place" + (missing > 1 ? "s" : "") + " couldn't be found; see the table.");
    } catch (err) {
        showError("Geocoding failed: " + err.message + " Check your connection and try again.");
    } finally {
        statusLine.textContent = "";
        plotButton.disabled = false;
    }
});

if (restore()) form.requestSubmit();
