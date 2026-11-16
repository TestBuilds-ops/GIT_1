const INSTAGRAM_HOSTS = ["instagram.com", "m.instagram.com", "instagr.am"];
const MEDIA_SEGMENTS = { p: "post", reel: "reel", reels: "reel", tv: "video" };
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
// Nominatim's usage policy allows at most one request per second.
const GEOCODE_GAP_MS = 1100;
// Places are searched for inside this box around the hotel (in degrees, about
// 55 km), and a match from anywhere else is kept only within MAX_PLACE_KM.
const NEARBY_DEGREES = 0.5;
const MAX_PLACE_KM = 150;
const OSRM = "https://router.project-osrm.org/route/v1/driving/";
const STORAGE_KEY = "stay-map-inputs";
const PALETTE = ["#c2186e", "#1f6fd1", "#16884a", "#e8710a", "#7b3fc4", "#0f9aa8", "#8a5a2b", "#d93025"];

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

function formatDuration(seconds) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    if (minutes < 60) return minutes + " min";
    return Math.floor(minutes / 60) + " h " + String(minutes % 60).padStart(2, "0") + " min";
}

// Picks black or white text for a pin, whichever reads better on its colour.
function textOn(hex) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? "#14282f" : "#ffffff";
}

const routeCache = new Map();

// Driving route from OSRM's public server (OpenStreetMap roads, free-flow
// times with no live traffic). Resolves to null when no road route exists.
async function drivingRoute(from, to) {
    const key = [from.lon, from.lat, to.lon, to.lat].join(",");
    if (routeCache.has(key)) return routeCache.get(key);
    const url = OSRM + from.lon + "," + from.lat + ";" + to.lon + "," + to.lat +
                "?overview=full&geometries=geojson";
    const response = await fetch(url);
    if (!response.ok && response.status !== 400) throw new Error("The router answered " + response.status + ".");
    const body = await response.json();
    const route = body.code === "Ok" && body.routes?.[0];
    const result = route
        ? { km: route.distance / 1000, seconds: route.duration,
            line: route.geometry.coordinates.map(([lon, lat]) => [lat, lon]) }
        : null;
    routeCache.set(key, result);
    return result;
}

function formatDistance(km) {
    return km < 1 ? Math.round(km * 1000) + " m" : km.toFixed(km < 10 ? 1 : 0) + " km";
}

const form = document.getElementById("stay-form");
const hotelRows = document.getElementById("hotel-rows");
const hotelTemplate = document.getElementById("hotel-template");
const addHotel = document.getElementById("add-hotel");
const rows = document.getElementById("link-rows");
const rowTemplate = document.getElementById("row-template");
const addRow = document.getElementById("add-row");
const plotButton = document.getElementById("plot");
const statusLine = document.getElementById("status");
const error = document.getElementById("error");
const mapPanel = document.getElementById("map-panel");
const tablePanel = document.getElementById("table-panel");
const tbody = document.getElementById("places-body");

function appendHotel(name = "") {
    const row = hotelTemplate.content.firstElementChild.cloneNode(true);
    row.querySelector(".hotel-name").value = name;
    row.querySelector(".remove").addEventListener("click", () => {
        row.remove();
        if (!hotelRows.children.length) appendHotel();
        relabel();
        save();
    });
    hotelRows.appendChild(row);
    relabel();
    return row;
}

function appendRow(url = "", place = "", color = "") {
    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    row.querySelector(".ig-url").value = url;
    row.querySelector(".ig-place").value = place;
    row.querySelector(".ig-color").value = color || PALETTE[rows.children.length % PALETTE.length];
    row.querySelector(".remove").addEventListener("click", () => {
        row.remove();
        if (!rows.children.length) appendRow();
        changed();
    });
    row.querySelector(".move-up").addEventListener("click", () => {
        if (row.previousElementSibling) rows.insertBefore(row, row.previousElementSibling);
        changed(row.querySelector(".move-up"));
    });
    row.querySelector(".move-down").addEventListener("click", () => {
        if (row.nextElementSibling) rows.insertBefore(row.nextElementSibling, row);
        changed(row.querySelector(".move-down"));
    });
    row.querySelector(".ig-color").addEventListener("change", () => changed());
    rows.appendChild(row);
    relabel();
    return row;
}

// Keeps the visible numbers and accessible names in step with the order.
function relabel() {
    [...hotelRows.children].forEach((row, i) => {
        const label = hotelRows.children.length > 1 ? "Hotel " + (i + 1) : "Hotel";
        row.querySelector(".badge").textContent = hotelRows.children.length > 1 ? "H" + (i + 1) : "H";
        row.querySelector(".hotel-name").setAttribute("aria-label", label + " name or address");
    });
    [...rows.children].forEach((row, i) => {
        row.querySelector(".badge").textContent = String(i + 1);
        row.querySelector(".move-up").disabled = i === 0;
        row.querySelector(".move-down").disabled = i === rows.children.length - 1;
        row.querySelector(".ig-color").setAttribute("aria-label", "Pin colour for place " + (i + 1));
    });
}

// Reordering or recolouring redraws an existing map straight away; lookups
// are cached, so this costs no new requests.
function changed(keepFocus) {
    relabel();
    save();
    if (keepFocus && !keepFocus.disabled) keepFocus.focus();
    if (!mapPanel.hidden) form.requestSubmit();
}

function readInputs() {
    return {
        hotels: [...hotelRows.children].map((row) => row.querySelector(".hotel-name").value.trim()),
        links: [...rows.children].map((row) => ({
            url: row.querySelector(".ig-url").value.trim(),
            place: row.querySelector(".ig-place").value.trim(),
            color: row.querySelector(".ig-color").value
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

// The homepage's form arrives here as ?ig=…&place=…&hotel=…&hotel2=…; those
// values replace whatever was saved, and the map is plotted straight away.
function restore() {
    const params = new URLSearchParams(location.search);
    if (params.has("ig") || params.has("hotel")) {
        appendHotel(params.get("hotel") || "");
        if (params.get("hotel2")) appendHotel(params.get("hotel2"));
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
    const hotels = saved?.hotels?.length ? saved.hotels : [saved?.hotel || ""];
    for (const hotel of hotels) appendHotel(hotel);
    const links = saved?.links?.length ? saved.links : [{ url: "", place: "" }];
    for (const link of links) appendRow(link.url, link.place, link.color);
    return false;
}

addHotel.addEventListener("click", () => {
    appendHotel().querySelector(".hotel-name").focus();
    save();
});
addRow.addEventListener("click", () => {
    appendRow().querySelector(".ig-url").focus();
    save();
});
form.addEventListener("input", (event) => {
    if (!event.target.classList.contains("ig-color")) save();
});

let map = null;
let layer = null;
let centreBar = null;
let plotted = { hotels: [], places: [] };
let activeHotel = 0;

function ensureMap() {
    if (map) return;
    map = L.map("map", { scrollWheelZoom: false, zoomSnap: 0.5 });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
    layer = L.layerGroup().addTo(map);

    const Centre = L.Control.extend({
        options: { position: "topleft" },
        onAdd() {
            centreBar = L.DomUtil.create("div", "centre-bar");
            L.DomEvent.disableClickPropagation(centreBar);
            return centreBar;
        }
    });
    new Centre().addTo(map);
    map.on("resize", frameOnHotel);
}

// One "Centre on" button per hotel; the pressed one owns the map's extent.
function drawCentreButtons() {
    centreBar.replaceChildren();
    plotted.hotels.forEach((hotel, i) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "recentre";
        button.textContent = plotted.hotels.length > 1 ? "Centre on " + hotel.label : "Centre on hotel";
        button.setAttribute("aria-pressed", String(i === activeHotel));
        button.addEventListener("click", () => {
            activeHotel = i;
            drawCentreButtons();
            frameOnHotel();
        });
        centreBar.appendChild(button);
    });
}

// Frames the map with the active hotel at its exact centre, zoomed out just
// far enough that its places (and their driving routes) fit. A box mirrored
// around the hotel gives the zoom.
function frameOnHotel() {
    const hotel = plotted.hotels[activeHotel];
    if (!map || !hotel) return;
    const points = plotted.places
        .filter((p) => p.point && p.hotel === hotel)
        .flatMap((p) => (p.route ? p.route.line : [[p.point.lat, p.point.lon]]));
    if (!points.length) {
        map.setView([hotel.lat, hotel.lon], 15);
        return;
    }
    const dLat = Math.max(...points.map(([lat]) => Math.abs(lat - hotel.lat)));
    const dLon = Math.max(...points.map(([, lon]) => Math.abs(lon - hotel.lon)));
    const bounds = L.latLngBounds([hotel.lat - dLat, hotel.lon - dLon], [hotel.lat + dLat, hotel.lon + dLon]);
    const zoom = Math.min(map.getBoundsZoom(bounds, false, L.point(48, 48)), 17);
    map.setView([hotel.lat, hotel.lon], zoom);
}

function pinIcon(className, label, color) {
    const style = color ? ' style="background:' + color + ";color:" + textOn(color) + '"' : "";
    return L.divIcon({
        className: "pin-icon " + className,
        html: "<span" + style + ">" + label + "</span>",
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

function legDetail(place) {
    const parts = ["From " + place.hotel.label];
    if (place.route) parts.push(formatDistance(place.route.km) + " drive, about " + formatDuration(place.route.seconds));
    parts.push(formatDistance(place.km) + " straight line");
    return parts.join(" · ");
}

function render(hotels, places) {
    ensureMap();
    layer.clearLayers();
    plotted = { hotels, places };
    if (activeHotel >= hotels.length) activeHotel = 0;
    // Open on a hotel that has places around it, rather than an empty one.
    const hasPlaces = (hotel) => places.some((p) => p.point && p.hotel === hotel);
    if (!hasPlaces(hotels[activeHotel])) {
        const withPlaces = hotels.findIndex(hasPlaces);
        if (withPlaces !== -1) activeHotel = withPlaces;
    }

    for (const hotel of hotels) {
        L.marker([hotel.lat, hotel.lon], {
            icon: pinIcon("hotel", hotel.badge),
            zIndexOffset: 1000,
            title: hotel.name
        }).bindPopup(popupContent(hotel.label + ": " + hotel.name, hotel.address)).addTo(layer);
    }

    for (const place of places.filter((p) => p.point)) {
        const line = place.route
            ? place.route.line
            : [[place.hotel.lat, place.hotel.lon], [place.point.lat, place.point.lon]];
        L.polyline(line, {
            className: place.route ? "route" : "spoke",
            color: place.color,
            interactive: false
        }).addTo(layer);
        L.marker([place.point.lat, place.point.lon], {
            icon: pinIcon("place", String(place.number), place.color),
            title: place.name
        }).bindPopup(popupContent(place.number + ". " + place.name, legDetail(place))).addTo(layer);
    }

    tbody.replaceChildren();
    for (const place of places) {
        const row = document.createElement("tr");
        const add = (text, className) => {
            const cell = document.createElement("td");
            cell.textContent = text;
            if (className) cell.className = className;
            row.appendChild(cell);
            return cell;
        };

        const number = add("", "cell-coord");
        const dot = document.createElement("span");
        dot.className = "swatch";
        dot.style.background = place.color;
        dot.style.color = textOn(place.color);
        dot.textContent = place.number;
        number.appendChild(dot);

        add(place.name, "cell-name");
        const source = add("");
        if (place.href) {
            const link = document.createElement("a");
            link.href = place.href;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = place.kind;
            source.appendChild(link);
        } else {
            source.textContent = place.kind;
        }
        add(place.point ? place.hotel.label : "—", "cell-coord");
        add(place.route ? formatDistance(place.route.km) : "—", "cell-coord");
        add(place.route ? formatDuration(place.route.seconds) : place.point ? "No road route" : "—", "cell-coord");
        add(place.point ? formatDistance(place.km) : "—", "cell-coord");
        const address = add(place.point ? place.point.address
            : "Not found within " + MAX_PLACE_KM + " km of a hotel — check the spelling or try the local name",
            "cell-addr");
        if (!place.point) address.classList.add("missing");
        tbody.appendChild(row);
    }

    mapPanel.hidden = false;
    tablePanel.hidden = false;
    drawCentreButtons();
    map.invalidateSize();
    frameOnHotel();
}

function showError(message) {
    error.textContent = message;
    error.hidden = !message;
}

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (plotButton.disabled) return;
    showError("");
    const inputs = readInputs();
    const hotelNames = inputs.hotels.filter(Boolean);

    if (!hotelNames.length) {
        showError("Enter a hotel so the map has somewhere to centre.");
        hotelRows.querySelector(".hotel-name").focus();
        return;
    }
    if (hotelNames.some(looksLikeWebAddress)) {
        showError("Each hotel box needs the hotel's name or street address, not a web address.");
        return;
    }

    const places = [];
    const problems = [];
    inputs.links.forEach((link, i) => {
        let { url, place } = link;
        const color = link.color;
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
            places.push({ number: places.length + 1, name: url, kind: "typed", href: null, color });
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
        places.push({ number: places.length + 1, name, kind: parsed.kind, href: parsed.href, color });
    });

    if (problems.length) {
        showError(problems.join(" "));
        return;
    }

    plotButton.disabled = true;
    try {
        const hotels = [];
        for (const [i, name] of hotelNames.entries()) {
            statusLine.textContent = "Finding " + name + "…";
            const hit = await geocode(name);
            if (!hit) {
                showError("Couldn't find “" + name + "”. Try adding the city or street address.");
                return;
            }
            const many = hotelNames.length > 1;
            hotels.push({ ...hit, name, badge: many ? "H" + (i + 1) : "H", label: many ? "Hotel " + (i + 1) : "the hotel" });
        }

        let noRouter = false;
        for (const place of places) {
            statusLine.textContent = "Finding " + place.name + " (" + place.number + " of " + places.length + ")…";
            // Each place is measured from whichever hotel it is found nearest to.
            let best = null;
            for (const hotel of hotels) {
                const point = await findNear(place.name, hotel);
                if (point && (!best || distanceKm(hotel, point) < best.km)) {
                    best = { point, hotel, km: distanceKm(hotel, point) };
                }
            }
            if (!best) continue;
            Object.assign(place, best);
            statusLine.textContent = "Working out the drive to " + place.name + "…";
            try {
                place.route = await drivingRoute(place.hotel, place.point);
            } catch {
                noRouter = true;
            }
        }

        render(hotels, places);
        const notes = [];
        const missing = places.filter((p) => !p.point).length;
        if (missing) notes.push(missing + " place" + (missing > 1 ? "s" : "") + " couldn't be found; see the table.");
        if (noRouter) notes.push("Driving routes couldn't be fetched, so straight lines are shown instead.");
        showError(notes.join(" "));
    } catch (err) {
        showError("Geocoding failed: " + err.message + " Check your connection and try again.");
    } finally {
        statusLine.textContent = "";
        plotButton.disabled = false;
    }
});

if (restore()) form.requestSubmit();
