import { useState, useCallback } from "react";
import type { VenueMapPoint, HexMapPoint, HourlyPoint } from "../types";
import { fetchVenueMap, fetchDropoffMap, fetchHourlyData } from "../api/client";

export function useMapData(city: string, lookbackDays: number) {
  const [venues, setVenues] = useState<VenueMapPoint[]>([]);
  const [hexagons, setHexagons] = useState<HexMapPoint[]>([]);
  const [hourly, setHourly] = useState<HourlyPoint[]>([]);
  const [loading, setLoading] = useState(false);

  const loadMapData = useCallback(async () => {
    setLoading(true);
    try {
      const days = Math.min(lookbackDays, 14);
      const [v, h, hr] = await Promise.all([
        fetchVenueMap(city, days),
        fetchDropoffMap(city, days),
        fetchHourlyData(city, days),
      ]);
      setVenues(v);
      setHexagons(h);
      setHourly(hr);
    } catch (e) {
      throw e;
    } finally {
      setLoading(false);
    }
  }, [city, lookbackDays]);

  return { venues, hexagons, hourly, loading, loadMapData };
}
