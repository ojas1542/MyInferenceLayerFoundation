import { defineTool } from "eve/tools";
import { z } from "zod";

interface OpenMeteoResponse {
  current?: {
    temperature_2m?: number;
    relative_humidity_2m?: number;
    wind_speed_10m?: number;
    weather_code?: number;
  };
  daily?: {
    time?: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    weather_code?: number[];
    snowfall_sum?: number[];
    precipitation_probability_max?: number[];
  };
}

// Every WMO weather code Open-Meteo returns. A code missing here would show
// as "Unknown", so snow and freezing rain must all be listed.
const WEATHER_CODES: Record<number, { text: string; icon: string }> = {
  0: { text: "Clear sky", icon: "sun" },
  1: { text: "Mainly clear", icon: "sun" },
  2: { text: "Partly cloudy", icon: "cloud-sun" },
  3: { text: "Overcast", icon: "cloud" },
  45: { text: "Fog", icon: "cloud-fog" },
  48: { text: "Freezing fog", icon: "cloud-fog" },
  51: { text: "Light drizzle", icon: "cloud-drizzle" },
  53: { text: "Drizzle", icon: "cloud-drizzle" },
  55: { text: "Heavy drizzle", icon: "cloud-drizzle" },
  56: { text: "Light freezing drizzle", icon: "cloud-hail" },
  57: { text: "Freezing drizzle", icon: "cloud-hail" },
  61: { text: "Light rain", icon: "cloud-rain" },
  63: { text: "Rain", icon: "cloud-rain" },
  65: { text: "Heavy rain", icon: "cloud-rain-wind" },
  66: { text: "Light freezing rain", icon: "cloud-hail" },
  67: { text: "Freezing rain", icon: "cloud-hail" },
  71: { text: "Light snow", icon: "cloud-snow" },
  73: { text: "Snow", icon: "cloud-snow" },
  75: { text: "Heavy snow", icon: "snowflake" },
  77: { text: "Snow grains", icon: "cloud-snow" },
  80: { text: "Light rain showers", icon: "cloud-rain" },
  81: { text: "Rain showers", icon: "cloud-rain" },
  82: { text: "Violent rain showers", icon: "cloud-rain-wind" },
  85: { text: "Light snow showers", icon: "cloud-snow" },
  86: { text: "Heavy snow showers", icon: "snowflake" },
  95: { text: "Thunderstorm", icon: "cloud-lightning" },
  96: { text: "Thunderstorm with hail", icon: "cloud-lightning" },
  99: { text: "Thunderstorm with heavy hail", icon: "cloud-lightning" },
};

function conditionFromCode(code?: number) {
  return (code === undefined ? undefined : WEATHER_CODES[code])
    ?? { text: "Unknown", icon: "cloud" };
}

const UNITS = {
  metric: {
    api: { temperature: "celsius", wind: "kmh", precipitation: "mm" },
    labels: { temperature: "°C", windSpeed: "km/h", snowfall: "cm" },
  },
  imperial: {
    api: { temperature: "fahrenheit", wind: "mph", precipitation: "inch" },
    labels: { temperature: "°F", windSpeed: "mph", snowfall: "in" },
  },
} as const;

async function geocode(location: string) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", location);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Geocoding failed");
  }

  const data = await response.json() as {
    results?: Array<{ name: string; latitude: number; longitude: number }>;
  };
  const result = data.results?.[0];
  if (!result) {
    throw new Error(`Could not find location: ${location}`);
  }

  return result;
}

const conditionSchema = z.object({
  text: z.string(),
  icon: z.string(),
});

export default defineTool({
  description: "Get current weather and a 5-day forecast for a location, "
    + "including daily snowfall and chance of precipitation. Every number "
    + "is in the units listed in the result's `units` field.",
  inputSchema: z.object({
    location: z.string().describe("City or place name"),
    units: z.enum(["imperial", "metric"]).describe(
      "imperial: °F, mph, inches. metric: °C, km/h, cm. Use the user's "
      + "preference; if unknown, imperial for places in the US, else metric.",
    ),
  }),
  outputSchema: z.object({
    location: z.string(),
    units: z.object({
      temperature: z.string(),
      windSpeed: z.string(),
      snowfall: z.string(),
    }),
    temperature: z.number(),
    temperatureHigh: z.number(),
    temperatureLow: z.number(),
    condition: conditionSchema,
    humidity: z.number(),
    windSpeed: z.number(),
    dailyForecast: z.array(
      z.object({
        day: z.string(),
        high: z.number(),
        low: z.number(),
        snowfall: z.number(),
        precipitationChance: z.number(),
        condition: conditionSchema,
      }),
    ),
  }),
  async execute({ location, units }) {
    const place = await geocode(location);
    const { api, labels } = UNITS[units];
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(place.latitude));
    url.searchParams.set("longitude", String(place.longitude));
    url.searchParams.set(
      "current",
      "temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code",
    );
    url.searchParams.set(
      "daily",
      "weather_code,temperature_2m_max,temperature_2m_min,snowfall_sum,"
      + "precipitation_probability_max",
    );
    url.searchParams.set("temperature_unit", api.temperature);
    url.searchParams.set("wind_speed_unit", api.wind);
    url.searchParams.set("precipitation_unit", api.precipitation);
    url.searchParams.set("timezone", "auto");
    url.searchParams.set("forecast_days", "5");

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error("Weather lookup failed");
    }

    const data = await response.json() as OpenMeteoResponse;
    const daily = data.daily;

    const dailyForecast = (daily?.time ?? []).slice(0, 5).map((day, i) => ({
      day,
      high: Math.round(daily?.temperature_2m_max?.[i] ?? 0),
      low: Math.round(daily?.temperature_2m_min?.[i] ?? 0),
      // Open-Meteo reports metric snowfall in cm even when rain is in mm.
      snowfall: Math.round((daily?.snowfall_sum?.[i] ?? 0) * 10) / 10,
      precipitationChance: daily?.precipitation_probability_max?.[i] ?? 0,
      condition: conditionFromCode(daily?.weather_code?.[i]),
    }));

    const today = dailyForecast[0];
    const current = Math.round(
      data.current?.temperature_2m ?? today?.high ?? 0,
    );

    return {
      location: place.name,
      units: labels,
      temperature: current,
      temperatureHigh: today?.high ?? current,
      temperatureLow: today?.low ?? current,
      condition: conditionFromCode(data.current?.weather_code),
      humidity: Math.round(data.current?.relative_humidity_2m ?? 0),
      windSpeed: Math.round(data.current?.wind_speed_10m ?? 0),
      dailyForecast,
    };
  },
});
