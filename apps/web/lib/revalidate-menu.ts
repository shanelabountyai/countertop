import { revalidatePath } from 'next/cache';

/**
 * Every surface a live-menu change has to reach: the two staff screens that
 * render the menu, and the three customer ones that price against it.
 *
 * One list, shared by the 86 board and the menu editor, because "the 86 board
 * updated the menu but the editor forgot the cart" is the same class of bug as
 * an 86 that only reaches the menu render (CLAUDE.md, "An 86 mid-flight
 * touches three surfaces").
 *
 * The surface deliberately NOT here is a placed order. It is a snapshot; if a
 * menu edit could change it, that is the defect this project exists to avoid.
 */
export function revalidateMenuSurfaces(): void {
  revalidatePath('/kitchen/availability');
  revalidatePath('/kitchen/menu');
  revalidatePath('/menu');
  revalidatePath('/menu/[itemId]', 'page');
  revalidatePath('/cart');
  revalidatePath('/checkout');
}
