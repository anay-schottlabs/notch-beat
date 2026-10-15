import { useEffect, useState } from "react";
import { displayService, type NotchGeometry } from "../services/display/displayService";

export function useNotchGeometry(): NotchGeometry | null {
  const [geometry, setGeometry] = useState<NotchGeometry | null>(null);
  useEffect(() => {
    let alive = true;
    displayService
      .geometry()
      .then((g) => alive && setGeometry(g))
      .catch(() => alive && setGeometry({ hasNotch: false, notchWidth: 0, notchHeight: 32, screenWidth: 0, screenHeight: 0, scaleFactor: 2 }));
    const off = displayService.onGeometryChange(setGeometry);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return geometry;
}
