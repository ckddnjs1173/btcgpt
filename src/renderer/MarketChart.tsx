import { useEffect, useRef } from 'react';
import {
  ColorType,
  createChart,
  type CandlestickData,
  type HistogramData,
  type Time,
} from 'lightweight-charts';

import type { TimeframeSnapshot } from '../shared/contracts';

function toTime(milliseconds: number): Time {
  return Math.floor(milliseconds / 1_000) as Time;
}

export function MarketChart({ timeframe }: { timeframe: TimeframeSnapshot }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    const chart = createChart(container.current, {
      width: container.current.clientWidth,
      height: 390,
      layout: {
        background: { type: ColorType.Solid, color: '#0b1321' },
        textColor: '#7f8da2',
      },
      grid: {
        vertLines: { color: '#152135' },
        horzLines: { color: '#152135' },
      },
      rightPriceScale: { borderColor: '#26364e' },
      timeScale: { borderColor: '#26364e', timeVisible: true },
    });
    const rows = [
      ...timeframe.closed,
      ...(timeframe.live ? [timeframe.live] : []),
    ];
    const candleData: CandlestickData[] = rows.map((row, index) => {
      const live = timeframe.live !== null && index === rows.length - 1;
      return {
        time: toTime(Number(row[0])),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        ...(live
          ? {
              color: '#64748b',
              borderColor: '#94a3b8',
              wickColor: '#94a3b8',
            }
          : {}),
      };
    });
    const candleSeries = chart.addCandlestickSeries({
      upColor: '#44d18b',
      downColor: '#f0646b',
      borderVisible: false,
      wickUpColor: '#44d18b',
      wickDownColor: '#f0646b',
    });
    candleSeries.setData(candleData);

    const volumeSeries = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    chart.priceScale('volume').applyOptions({
      scaleMargins: { top: 0.78, bottom: 0 },
    });
    volumeSeries.setData(
      rows.map((row): HistogramData => ({
        time: toTime(Number(row[0])),
        value: Number(row[5]),
        color:
          Number(row[4]) >= Number(row[1])
            ? 'rgba(68,209,139,.35)'
            : 'rgba(240,100,107,.35)',
      })),
    );

    for (const [price, color, title] of [
      [timeframe.indicators.pivotHigh, '#f0646b', 'Pivot H'],
      [timeframe.indicators.pivotLow, '#44d18b', 'Pivot L'],
    ] as const)
      if (price !== null)
        candleSeries.createPriceLine({
          price,
          color,
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title,
        });
    chart.timeScale().fitContent();

    const observer = new ResizeObserver(([entry]) => {
      if (entry) chart.applyOptions({ width: entry.contentRect.width });
    });
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      chart.remove();
    };
  }, [timeframe]);

  return <div className="market-chart" ref={container} />;
}
