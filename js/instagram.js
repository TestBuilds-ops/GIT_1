const INSTAGRAM_HOSTS = ["instagram.com", "m.instagram.com", "instagr.am"];
const MEDIA_SEGMENTS = { p: "post", reel: "reel", reels: "reel", tv: "video" };
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
// Nominatim's usage policy allows at most one request per second.
const GEOCODE_GAP_MS = 1100;
// How far around the hotel (in degrees) to prefer matches for a place name.
const NEARBY_DEGREES = 0.3;
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

async function geocode(query, near) {
    const params = new URLSearchParams({ q: query, format: "jsonv2", limit: "1" });
    if (near) {
        const d = NEARBY_DEGREES;
        params.set("viewbox", [near.lon - d, near.lat + d, near.lon + d, near.lat - d].join(","));
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

function restore() {
    let saved = null;
    try {
        saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch {
        saved = null;
    }
    hotelInput.value = saved?.hotel || "";
    const links = saved?.links?.length ? saved.links : [{ url: "", place: "" }];
    for (const link of links) appendRow(link.url, link.place);
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
            place.point ? place.point.address : "Not found — try a more specific place name"
        ];
        cells.forEach((text, i) => {
            const cell = document.createElement("td");
            if (i === 2) {
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

    const places = [];
    const problems = [];
    inputs.links.forEach((link, i) => {
        if (!link.url && !link.place) return;
        const parsed = parseInstagram(link.url);
        if (!parsed) {
            problems.push("Link " + (i + 1) + " isn't an Instagram post, reel, profile or location link.");
            return;
        }
        const name = link.place || parsed.place;
        if (!name) {
            problems.push("Link " + (i + 1) + " is a " + parsed.kind +
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
            place.point = await geocode(place.name, hotel);
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

restore();
