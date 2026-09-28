export class ScrollViewport {
  width;
  height;
  contentWidth = 0;
  contentHeight = 0;
  x = 0;
  y = 0;

  constructor(width, height) {
    this.resize(width, height);
  }

  resize(width, height) {
    this.width = dimension(width);
    this.height = dimension(height);
    this.#clamp();
  }

  setContentSize(width, height) {
    this.contentWidth = dimension(width);
    this.contentHeight = dimension(height);
    this.#clamp();
  }

  scrollBy(deltaX = 0, deltaY = 0) {
    return this.scrollTo(this.x + finite(deltaX), this.y + finite(deltaY));
  }

  scrollTo(x = this.x, y = this.y) {
    const previousX = this.x;
    const previousY = this.y;
    this.x = clamp(finite(x), 0, Math.max(0, this.contentWidth - this.width));
    this.y = clamp(finite(y), 0, Math.max(0, this.contentHeight - this.height));
    return this.x !== previousX || this.y !== previousY;
  }

  #clamp() {
    this.scrollTo(this.x, this.y);
  }
}

function dimension(value) {
  return Math.max(0, finite(value));
}

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

