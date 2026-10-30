// 코스 방문 순서 정리. 어떤 장소를 넣을지는 planRoute의 우선순위(최애가 다녀간 곳 먼저)가 정하고,
// 여기서는 그 장소들을 가까운 곳끼리 이어지게 순서만 바꾼다. 첫 장소(가장 우선순위가 높은 곳)는
// 그대로 첫 번째로 두고, 가까운 곳부터 고른 뒤(nearest neighbour) 선이 교차하는 구간을 뒤집어 푼다(2-opt).

export interface LatLng {
  lat: number;
  lng: number;
}

const hasCoords = (p: LatLng) => Number.isFinite(p.lat) && Number.isFinite(p.lng);

export function distanceKm(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pathLengthKm(path: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += distanceKm(path[i - 1]!, path[i]!);
  return total;
}

/** 첫 장소를 고정하고 가까운 순으로 정렬한다. 좌표가 없는 장소는 순서를 지킨 채 맨 뒤로. */
export function orderByProximity<T extends LatLng>(places: T[]): T[] {
  if (places.length <= 2) return [...places];
  const located = places.filter(hasCoords);
  const unlocated = places.filter((p) => !hasCoords(p));
  if (located.length <= 2) return [...located, ...unlocated];

  // 첫 장소가 좌표가 없으면 좌표 있는 첫 장소부터 시작한다.
  const path: T[] = [located[0]!];
  const rest = located.slice(1);
  while (rest.length) {
    const last = path[path.length - 1]!;
    let best = 0;
    for (let i = 1; i < rest.length; i++) if (distanceKm(last, rest[i]!) < distanceKm(last, rest[best]!)) best = i;
    path.push(rest.splice(best, 1)[0]!);
  }

  // 2-opt (열린 경로, 시작점 고정): path[i..k]를 뒤집어 더 짧아지면 바꾼다.
  const d = (a: number, b: number) => distanceKm(path[a]!, path[b]!);
  let improved = true;
  for (let round = 0; improved && round < 50; round++) {
    improved = false;
    for (let i = 1; i < path.length - 1; i++) {
      for (let k = i + 1; k < path.length; k++) {
        const before = d(i - 1, i) + (k + 1 < path.length ? d(k, k + 1) : 0);
        const after = d(i - 1, k) + (k + 1 < path.length ? d(i, k + 1) : 0);
        if (after + 1e-9 < before) {
          path.splice(i, k - i + 1, ...path.slice(i, k + 1).reverse());
          improved = true;
        }
      }
    }
  }
  return [...path, ...unlocated];
}
