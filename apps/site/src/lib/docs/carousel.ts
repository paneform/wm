export interface CarouselViewport {
  left: number;
  width: number;
  contentWidth: number;
}
export interface CarouselCard {
  left: number;
  width: number;
}

/** Reveal a card without moving the document or disturbing cards already in view. */
export function carouselTarget(view: CarouselViewport, card: CarouselCard): number {
  const visible = card.left >= view.left && card.left + card.width <= view.left + view.width;
  const target = visible ? view.left : card.left;
  return Math.max(0, Math.min(target, view.contentWidth - view.width));
}

/** The last card cannot always snap to the leading edge; the end stop selects it. */
export function carouselSelection(view: CarouselViewport, cards: readonly CarouselCard[]): number {
  if (!cards.length || view.left <= 1) return 0;
  if (view.left >= view.contentWidth - view.width - 1) return cards.length - 1;
  return cards.reduce(
    (nearest, card, index) =>
      Math.abs(card.left - view.left) < Math.abs(cards[nearest]!.left - view.left)
        ? index
        : nearest,
    0,
  );
}
