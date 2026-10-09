/** A Set that forgets its oldest entries beyond `max` (insertion order). */
export class BoundedSet<T> {
    private readonly items = new Set<T>();

    constructor(private readonly max: number) {}

    add(value: T): this {
        this.items.delete(value);
        this.items.add(value);
        while (this.items.size > this.max) {
            this.items.delete(this.items.values().next().value as T);
        }
        return this;
    }

    has(value: T): boolean {
        return this.items.has(value);
    }

    get size(): number {
        return this.items.size;
    }
}
