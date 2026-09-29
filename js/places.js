// Places named in the description of https://www.youtube.com/watch?v=d4hSykAvpi0
// The video is a 30-second trailer with no caption track, so the description is
// the only source text available. Coordinates and addresses come from
// OpenStreetMap Nominatim. "source" records whether the video named the place
// outright or whether it was inferred from a phrase.
const PLACES = [
    {
        id: "normandy",
        name: "Normandy",
        quote: "“from Normandy in the north”",
        source: "named",
        lat: "49.0678",
        lon: "0.3139",
        address: "Normandie, France métropolitaine, France"
    },
    {
        id: "atlantic",
        name: "French Atlantic coast",
        quote: "“the west coast of France” — “the Atlantic coast”",
        source: "named",
        lat: "45.6157",
        lon: "-3.6585",
        address: "Golfe de Gascogne / Golfo de Vizcaya / Bay of Biscay"
    },
    {
        id: "border",
        name: "Spanish border",
        quote: "“down to the Spanish border”",
        source: "inferred",
        lat: "43.3642",
        lon: "-1.7616",
        address: "Hendaye, Bayonne, Pyrénées-Atlantiques, Nouvelle-Aquitaine, France métropolitaine, 64700, France"
    }
];
