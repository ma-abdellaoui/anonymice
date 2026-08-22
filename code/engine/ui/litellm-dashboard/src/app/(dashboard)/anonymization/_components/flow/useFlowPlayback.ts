import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BEATS, type Beat } from "./flowTypes";

/** How long each beat holds before the next one starts, at 1x. */
const HOLD_MS: Record<Beat, number> = {
  typed: 1400,
  detect: 2600,
  encode: 3000,
  cross: 2600,
  reply: 2600,
  decode: 3400,
};

export interface Playback {
  beat: Beat;
  index: number;
  isPlaying: boolean;
  atEnd: boolean;
  speed: number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  next: () => void;
  previous: () => void;
  goTo: (index: number) => void;
  restart: () => void;
  setSpeed: (speed: number) => void;
}

/**
 * Steps through the beats on a timer that can be taken over by hand.
 *
 * Presenting is the reason for the manual controls: a question during the
 * encode beat should not be answered while the animation has moved on.
 */
export const useFlowPlayback = (enabled: boolean): Playback => {
  const [index, setIndex] = useState(0);
  const [wantsToPlay, setWantsToPlay] = useState(false);
  const [speed, setSpeed] = useState(1);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const atEnd = index >= BEATS.length - 1;
  const isPlaying = wantsToPlay && !atEnd;

  const clear = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => {
    if (!enabled || !isPlaying) return;
    timer.current = setTimeout(() => setIndex((current) => current + 1), HOLD_MS[BEATS[index]] / speed);
    return clear;
  }, [enabled, isPlaying, index, speed, clear]);

  const goTo = useCallback(
    (target: number) => {
      clear();
      setWantsToPlay(false);
      setIndex(Math.min(Math.max(target, 0), BEATS.length - 1));
    },
    [clear],
  );

  const restart = useCallback(() => {
    clear();
    setIndex(0);
    setWantsToPlay(true);
  }, [clear]);

  return useMemo(
    () => ({
      beat: BEATS[index],
      index,
      isPlaying,
      atEnd,
      speed,
      play: () => setWantsToPlay(true),
      pause: () => setWantsToPlay(false),
      toggle: () => setWantsToPlay((current) => !current),
      next: () => goTo(index + 1),
      previous: () => goTo(index - 1),
      goTo,
      restart,
      setSpeed,
    }),
    [index, isPlaying, atEnd, speed, goTo, restart],
  );
};
