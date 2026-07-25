import { createContext, useContext } from "react";
import type { Filters, TabView } from "../types";

export interface FilterContextValue {
  filters: Filters;
  setFilters: React.Dispatch<React.SetStateAction<Filters>>;
  activeTab: TabView;
  setActiveTab: (tab: TabView) => void;
}

export const FilterContext = createContext<FilterContextValue>({
  filters: { city: "Ridgeport", lookbackDays: 28, sizeFilter: "all", periodMode: "lookback" },
  setFilters: () => {},
  activeTab: "region",
  setActiveTab: () => {},
});

export function useFilters() {
  return useContext(FilterContext);
}
