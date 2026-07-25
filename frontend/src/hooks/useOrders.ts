import { useState, useCallback } from "react";
import type {
  LateOrder,
  TrendPoint,
  RottenOrder,
  RottenSummaryDay,
} from "../types";
import {
  fetchLateOrders,
  fetchLateTrend,
  fetchRottenOrders,
  fetchRottenSummary,
} from "../api/client";

interface UseOrdersState {
  lateOrders: LateOrder[];
  trendData: TrendPoint[];
  rottenOrders: RottenOrder[];
  rottenSummary: RottenSummaryDay[];
  loading: boolean;
  error: string | null;
}

export function useOrders(city: string, lookbackDays: number) {
  const [state, setState] = useState<UseOrdersState>({
    lateOrders: [],
    trendData: [],
    rottenOrders: [],
    rottenSummary: [],
    loading: false,
    error: null,
  });

  const loadLateData = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const [ordersResp, trend] = await Promise.all([
        fetchLateOrders(city, lookbackDays),
        fetchLateTrend(city, lookbackDays),
      ]);
      setState((s) => ({
        ...s,
        lateOrders: ordersResp.orders,
        trendData: trend,
        loading: false,
      }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to load late orders";
      setState((s) => ({ ...s, loading: false, error: msg }));
      throw e;
    }
  }, [city, lookbackDays]);

  const loadRottenData = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const rottenDays = Math.min(lookbackDays, 14);
      const [ordersResp, summary] = await Promise.all([
        fetchRottenOrders(city, rottenDays),
        fetchRottenSummary(city, rottenDays),
      ]);
      setState((s) => ({
        ...s,
        rottenOrders: ordersResp.orders,
        rottenSummary: summary,
        loading: false,
      }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to load severely delayed deliveries";
      setState((s) => ({ ...s, loading: false, error: msg }));
      throw e;
    }
  }, [city, lookbackDays]);

  return { ...state, loadLateData, loadRottenData };
}
