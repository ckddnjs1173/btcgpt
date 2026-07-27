import { useEffect, useRef } from 'react';
import {
  ColorType,
  createChart,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type Time,
} from 'lightweight-charts';

import type { TimeframeSnapshot } from '../shared/contracts';

function rollingEma(values: number[], period: number): Array<number | null> {
  if (values.length < period) return values.map(() => null);
  const output: Array<number | null> = Array.from(
    { length: period - 1 },
    () => null,
  );
  let current =
    values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  output.push(current);
  const multiplier = 2 / (period + 1);
  for (const value of values.slice(period)) {
    current = value * multiplier + current * (1 - multiplier);
    output.push(current);
  }
  return output;
}

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

    const closes = rows.map((row) => Number(row[4]));
    const times = rows.map((row) => toTime(Number(row[0])));
    for (const [period, color] of [
      [20, '#f7b955'],
      [50, '#6aa9ff'],
      [200, '#b68cff'],
    ] as const) {
      const values = rollingEma(closes, period);
      const series = chart.addLineSeries({
        color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      series.setData(
        values.flatMap((value, index): LineData[] =>
          value === null ? [] : [{ time: times[index]!, value }],
        ),
      );
    }

    let cumulativeTypicalVolume = 0;
    let cumulativeVolume = 0;
    let sessionDay = '';
    const vwapData = rows.flatMap((row): LineData[] => {
      const nextDay = new Date(Number(row[0])).toISOString().slice(0, 10);
      if (nextDay !== sessionDay) {
        sessionDay = nextDay;
        cumulativeTypicalVolume = 0;
        cumulativeVolume = 0;
      }
      const volume = Number(row[5]);
      const typical = (Number(row[2]) + Number(row[3]) + Number(row[4])) / 3;
      cumulativeTypicalVolume += typical * volume;
      cumulativeVolume += volume;
      return cumulativeVolume > 0
        ? [
            {
              time: toTime(Number(row[0])),
              value: cumulativeTypicalVolume / cumulativeVolume,
            },
          ]
        : [];
    });
    const vwapSeries = chart.addLineSeries({
      color: '#2dd4bf',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    vwapSeries.setData(vwapData);
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
