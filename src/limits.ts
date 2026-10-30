// 과금 보호: 서버 전체 시간당 메시지 상한 (최근 60분 슬라이딩 윈도). 사용자당 상한은 app-state의 messagesSent.
export class HourlyLimit {
  private readonly times: number[] = [];

  constructor(private readonly max: number, private readonly now: () => number = Date.now) {}

  /** 하나 쓸 수 있으면 기록하고 true. 상한이면 false(기록 안 함). max가 0이면 항상 false. */
  tryTake(): boolean {
    const hourAgo = this.now() - 60 * 60 * 1000;
    while (this.times.length && this.times[0]! <= hourAgo) this.times.shift();
    if (this.times.length >= this.max) return false;
    this.times.push(this.now());
    return true;
  }

  get used(): number {
    const hourAgo = this.now() - 60 * 60 * 1000;
    return this.times.filter((t) => t > hourAgo).length;
  }
}
