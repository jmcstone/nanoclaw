---
name: ambient-weather
description: Query Jeff's Ambient Weather personal weather station — current outdoor + indoor conditions (temperature, humidity, wind, rain, barometric pressure, dew point, feels-like) and historical/aggregate trends. Use whenever the user asks about the weather at home, outside/inside temperature, humidity, wind, rain totals, the weather station, or a specific room's conditions.
---

# Ambient Weather Station

Jeff's home weather station data, served by a Spring Boot / Spring Data REST API on the tailnet. **Read-only, no key.**

- **Base URL:** `$AMBIENT_WEATHER_URL` (env var injected into this container; resolves via MagicDNS — no proxy). Always use the env var, never a hardcoded host.
- **Discovery:** OpenAPI at `$AMBIENT_WEATHER_URL/v3/api-docs`, Swagger UI at `/swagger-ui/index.html`.
- HAL/HATEOAS responses (`_embedded`, `_links`). Dates are ISO-8601 UTC (`…Z`).

## Current conditions (the main one)

`measurementDetails/search/mostRecent` returns the latest value for every parameter across all sensors — self-describing with `parameterCode`, `parameterDescription`, `categoryName`, `sensorName`, `value`. **Pass a recent time window** (it returns readings whose timestamp falls in `[fromDate, toDate]`; the station logs every ~5 min, so a 1-hour window is safe):

```bash
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
AGO=$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)
curl -s "$AMBIENT_WEATHER_URL/measurementDetails/search/mostRecent?fromDate=$AGO&toDate=$NOW"
```

Each item looks like: `{"parameterCode":"temp1f","parameterDescription":"Temperature","sensorName":"Elin's Bedroom","value":75.9, ...}`. Filter/summarize for what the user asked (outdoor temp, a room, wind, etc.).

## Parameter codes (Ambient Weather standard)

| code | meaning |
|------|---------|
| `tempf` / `tempinf` | outdoor / indoor temperature (°F) |
| `temp1f`…`temp4f` | extra sensor temps (named rooms) |
| `humidity`, `humidity1`… | humidity (%) outdoor / per sensor |
| `feelsLike*`, `dewPoint*` | feels-like, dew point |
| `windspeedmph`, `windgustmph`, `maxdailygust`, `winddir` | wind |
| `baromrelin`, `baromabsin` | barometric pressure (inHg) |
| `hourlyrainin`, `dailyrainin`, `eventrainin`, `weeklyrainin`, `monthlyrainin`, `yearlyrainin` | rain totals |

Full list: `GET /parameters`. Sensors (named rooms + outdoor): `GET /sensors`.

## Historical series

One parameter over a time range (params are `parameterCode`, `fromDate`, `toDate`):

```bash
curl -s "$AMBIENT_WEATHER_URL/measurements/search/findAllByCodeAndDateBetween?parameterCode=tempf&fromDate=2026-06-06T00:00:00Z&toDate=2026-06-07T00:00:00Z"
```

## Aggregates

- `GET /monthlyOutdoorTemperatures`, `GET /yearlyOutdoorTemperatures`
- `GET /monthlyRains`
- `…ParameterRanges/search/findAllByCodeAndDateBetween` (daily/weekly/monthly/yearly min-max) — params `code`/`fromDate`/`toDate` per api-docs.

## Notes
- Param names matter: the measurement searches use `parameterCode` (not `code`); wrong names return an **empty** `_embedded` list silently, not an error. Check `/v3/api-docs` if a query comes back empty.
- Responses paginate (`?size=N&sort=…`).
- Everything here is read-only — no commands, no key.
