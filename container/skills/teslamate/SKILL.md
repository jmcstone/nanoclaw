---
name: teslamate
description: Query and control Jeff's Tesla via the TeslaMate tracker API (car status, battery/charge state, location, drives, charging history, software updates, and vehicle commands like wake/climate/charging). Use whenever the user asks about the car, the Tesla, "Amped", battery level, range, where the car is, recent drives, charging, or wants to send a command to the vehicle.
---

# TeslaMate Tracker API

Jeff's Tesla data + control, served by a Spring Boot API on the tailnet.

- **Base URL:** `$TESLA_TRACKER_URL` (env var injected into this container; resolves via MagicDNS — no proxy needed). Always use the env var, not a hardcoded host.
- **Discovery:** OpenAPI at `$TESLA_TRACKER_URL/v3/api-docs`, Swagger UI at `/swagger-ui/index.html`. 152 endpoints — when you need something not listed below, grep the api-docs.
- **Reads need NO key.** Just GET.
- **Commands need a key:** send header `X-API-Key: $TESLA_TRACKER_API_KEY` (injected into this container's env). Never print the key.

## Cars

| id | name | model |
|----|------|-------|
| **1** | **Amped** | Model Y LR AWD Performance — **default to this** |
| 2 | (secondary) | Model Y |

Use car id **1** unless the user means the other vehicle.

## Common reads (no key)

```bash
# Live-ish status (active route, state)
curl -s $TESLA_TRACKER_URL/cars/1/status

# Static car info (VIN, model, efficiency, name)
curl -s $TESLA_TRACKER_URL/cars/1

# Full live vehicle data (battery %, range, climate, location) — needs car AWAKE
curl -s $TESLA_TRACKER_URL/cars/1/vehicleData

# Time-series measurements (paginated)
curl -s $TESLA_TRACKER_URL/cars/1/measurements

# Nearby chargers — needs car AWAKE
curl -s $TESLA_TRACKER_URL/cars/1/nearbyChargingSites

# Software update history
curl -s $TESLA_TRACKER_URL/cars/1/softwareUpdates
```

### Spring Data REST query endpoints
The API exposes JPA repositories with `search/findBy…` routes. Useful ones:

```bash
# Recent drives for a car
curl -s "$TESLA_TRACKER_URL/drives/search/findAllByCarId?carId=1"

# Charging sessions for a car
curl -s "$TESLA_TRACKER_URL/chargingProcesses/search/findAllByCarId?carId=1"

# Drive detail variants, charging detail, attributes, addresses, geofences …
# Browse /v3/api-docs for the full findBy… set (filter by distance, date range, address, etc.)
```

Responses are paginated (`{"content":[…],"page":{…}}`) — add `?size=N&sort=field,desc` as needed.

## Commands (key required)

```bash
curl -s -X POST \
  -H "X-API-Key: $TESLA_TRACKER_API_KEY" \
  $TESLA_TRACKER_URL/cars/1/commands/<command>
```

- The car must usually be **awake** for live commands. If a command or `vehicleData` fails with the car asleep, wake it first (`wake_up`) and retry after a few seconds.
- Exact command tokens (wake, climate on/off, charge start/stop/limit, etc.) are listed in the Swagger UI / api-docs — check there rather than guessing.

## Gotchas

- Car **asleep/offline** → `/vehicleData` returns 500, `/nearbyChargingSites` returns 503. That's normal when parked; wake first if you need live data.
- `/cars/1/status` works even when asleep (returns last-known + route state).
- Confirm with the user before sending **state-changing commands** (unlock, climate, charging changes) — these act on the real vehicle.
