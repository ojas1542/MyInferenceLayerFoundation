export interface WeatherCondition {
  text: string;
  icon: string;
}

export interface WeatherUnits {
  temperature: string;
  windSpeed: string;
  snowfall: string;
}

// The fields marked optional are missing from weather results saved before
// the tool reported units, snowfall and chance of precipitation.
export interface WeatherForecastDay {
  day: string;
  high: number;
  low: number;
  snowfall?: number;
  precipitationChance?: number;
  condition: WeatherCondition;
}

export interface WeatherOutput {
  location: string;
  units?: WeatherUnits;
  temperature: number;
  temperatureHigh: number;
  temperatureLow: number;
  condition: WeatherCondition;
  humidity: number;
  windSpeed: number;
  dailyForecast: WeatherForecastDay[];
}
