// Read-only mock data access. Only data/items.json and data/places.json are the source of
// truth — tools must not invent facts that are not in these files (PRD §8).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, "..", "data");

export interface Item {
  id: string;
  group: string;
  member: string; // "단체"면 멤버 전원이 같이 착용
  situation: string;
  date: string;
  category: string;
  detailCategory: string | null;
  brand: string;
  name: string;
  price: number | null; // null이면 priceText를 대신 쓴다 ($83, ¥1490 등 원화 아닌 가격)
  priceText: string | null;
  url: string; // 바로 구매 링크 (쇼핑몰 검색 결과 또는 실제 상품 페이지)
  shop: string | null; // "무신사", "네이버", "랄프로렌 공식몰" 등
  imageUrl?: string | null; // 손민수위키 실제 제품 사진 (별도 전달 시 우선 사용)
  wikiUrl: string | null; // 손민수위키 상세 페이지. isSample이면 보통 null
  sourceUrl: string | null; // 최초 목격 출처 (유튜브 타임스탬프 등)
  features: string;
  accuracy: string | null; // "certain" 등 손민수위키 검수 상태
  matchType: "exact" | "similar" | "sample" | "source_only"; // exact=원래 제품, similar=정품 미확인 유사 제품, sample=시연용 예시
  soldOut: boolean;
  stockStatus?: "unknown" | "in_stock" | "sold_out"; // 팬 계정 데이터는 재고 미확인
  fanSourceUrls?: string[]; // 검수 레코드와 연결되는 X 원본 추가 링크
  workbenchIds?: string[]; // 원본 후보 작업대 행(중복 병합 포함)
  priceProvenance?: string; // 가격 중 일부는 작업대 기록
  workbenchId?: string; // HTML 작업대 원본 행 식별자
  workbenchStock?: string; // 작업대 기록 당시의 판매 여부 (실시간 재고 아님)
  isOriginal: boolean;
  alternativeOf: string | null;
  isSample: boolean; // true면 손민수위키 검수 데이터가 아니라 시연용 예시 대체템
}

export interface PlaceVisit {
  group: string;
  member: string; // "단체"면 멤버 전원
  date: string | null;
  context: string | null; // "Fan Spot"/"Variety"/"SNS" 같은 짧은 태그
}

export interface Place {
  id: string;
  name: string;
  area: string;
  region: string;
  address: string;
  type: string;
  visits: PlaceVisit[];
  openHours: string | null;
  note: string;
  mustTry: string | null; // "위시 픽: ..." 한 줄로 카드에 보여줄 메뉴/할 일
  context: string | null; // 장소에 대한 긴 설명(왜 성지인지 등)
  tip: string | null;
  lat: number;
  lng: number;
  naverMapUrl: string;
  googleMapUrl: string | null;
  recreeUrl: string | null;
  imageUrl?: string | null; // reCree 장소 사진 (별도 전달 시 우선 사용)
  sourceUrl: string | null;
  isFandomSpot: boolean;
}

export interface Aliases {
  members: Record<string, string[]>;
  groups: Record<string, string[]>;
}

let itemsCache: Item[] | null = null;
let placesCache: Place[] | null = null;
let aliasesCache: Aliases | null = null;

export async function loadItems(): Promise<Item[]> {
  if (!itemsCache) {
    const raw = await readFile(path.join(dataDir, "items.json"), "utf-8");
    itemsCache = JSON.parse(raw) as Item[];
  }
  return itemsCache;
}

export async function loadPlaces(): Promise<Place[]> {
  if (!placesCache) {
    const raw = await readFile(path.join(dataDir, "places.json"), "utf-8");
    placesCache = JSON.parse(raw) as Place[];
  }
  return placesCache;
}

export async function loadAliases(): Promise<Aliases> {
  if (!aliasesCache) {
    const raw = await readFile(path.join(dataDir, "aliases.json"), "utf-8");
    aliasesCache = JSON.parse(raw) as Aliases;
  }
  return aliasesCache;
}

export async function findItemById(id: string): Promise<Item | undefined> {
  const items = await loadItems();
  return items.find((i) => i.id === id);
}

export async function findPlaceById(id: string): Promise<Place | undefined> {
  const places = await loadPlaces();
  return places.find((p) => p.id === id);
}
