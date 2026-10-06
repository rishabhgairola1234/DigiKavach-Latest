// Shared default-location config for everything that needs a "where is
// this app based" assumption: geocoding preference, and the starting view
// for the public Safety Map. Change these if DigiKavach is deployed for a
// different city.

export const DEFAULT_CITY = "Dehradun";
export const DEFAULT_STATE = "Uttarakhand";
export const DEFAULT_COUNTRY = "India";

export const DEFAULT_CENTER = { lat: 30.3165, lng: 78.0322 };
export const DEFAULT_ZOOM = 12;

// Used as a Nominatim viewbox PREFERENCE (bounded=0) -- biases ambiguous,
// city-less queries ("Railway Station") toward Dehradun without excluding a
// query that names a different place ("Railway Station, Chennai").
export const DEHRADUN_VIEWBOX = {
  minLat: 30.15,
  maxLat: 30.5,
  minLng: 77.85,
  maxLng: 78.3,
};

export function isWithinDehradunViewbox(lat: number, lng: number): boolean {
  return (
    lat >= DEHRADUN_VIEWBOX.minLat &&
    lat <= DEHRADUN_VIEWBOX.maxLat &&
    lng >= DEHRADUN_VIEWBOX.minLng &&
    lng <= DEHRADUN_VIEWBOX.maxLng
  );
}
