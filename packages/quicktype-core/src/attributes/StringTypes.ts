import {
    addHashCode,
    areEqual,
    definedMap,
    hashCodeOf,
    iterableFirst,
    mapMap,
    mapMergeWithInto,
    setIntersect,
    setUnionInto,
} from "collection-utils";

import type { DateTimeRecognizer } from "../DateTime";
import { assert, defined } from "../support/Support";
import type { TransformedStringTypeKind } from "../Type/TransformedStringType";
import {
    type StringTypeMapping,
    stringTypeMappingGet,
} from "../Type/TypeBuilderUtils";

import { TypeAttributeKind } from "./TypeAttributes";

export class StringTypes {
    public static readonly unrestricted: StringTypes = new StringTypes(
        undefined,
        new Set(),
    );

    public static fromCase(s: string, count: number): StringTypes {
        const caseMap: { [name: string]: number } = {};
        caseMap[s] = count;
        return new StringTypes(
            new Map([[s, count] as [string, number]]),
            new Set(),
        );
    }

    public static fromCases(cases: string[]): StringTypes {
        const caseMap: { [name: string]: number } = {};
        for (const s of cases) {
            caseMap[s] = 1;
        }

        return new StringTypes(
            new Map(cases.map((s) => [s, 1] as [string, number])),
            new Set(),
        );
    }

    // undefined means no restrictions
    public constructor(
        public readonly cases: ReadonlyMap<string, number> | undefined,
        public readonly transformations: ReadonlySet<TransformedStringTypeKind>,
    ) {
        if (cases === undefined) {
            assert(
                transformations.size === 0,
                "We can't have an unrestricted string that also allows transformations",
            );
        }
    }

    public get isRestricted(): boolean {
        return this.cases !== undefined;
    }

    public union(othersArray: StringTypes[], startIndex: number): StringTypes {
        if (this.cases === undefined) return this;

        const cases = new Map(this.cases);
        const transformations = new Set(this.transformations);

        for (let i = startIndex; i < othersArray.length; i++) {
            const other = othersArray[i];

            if (other.cases === undefined) return other;
            mapMergeWithInto(cases, (x, y) => x + y, other.cases);

            setUnionInto(transformations, other.transformations);
        }

        return new StringTypes(cases, transformations);
    }

    public intersect(
        othersArray: StringTypes[],
        startIndex: number,
    ): StringTypes {
        let cases = this.cases;
        let transformations = this.transformations;

        for (let i = startIndex; i < othersArray.length; i++) {
            const other = othersArray[i];

            if (cases === undefined) {
                cases = definedMap(other.cases, (m) => new Map(m));
            } else if (other.cases !== undefined) {
                const thisCases = cases;
                const otherCases = other.cases;

                const intersects = setIntersect(
                    thisCases.keys(),
                    new Set(otherCases.keys()),
                );
                const entries =
                    intersects.size > 0
                        ? intersects.entries()
                        : new Set(thisCases.keys()).entries();
                cases = mapMap(entries, (k) => {
                    const thisValue = defined(thisCases.get(k));
                    const otherValue = otherCases.get(k) ?? Math.min();
                    return Math.min(thisValue, otherValue);
                });
            }

            transformations = setIntersect(
                transformations,
                other.transformations,
            );
        }

        return new StringTypes(cases, transformations);
    }

    public applyStringTypeMapping(mapping: StringTypeMapping): StringTypes {
        if (!this.isRestricted) return this;

        const kinds = new Set<TransformedStringTypeKind>();
        for (const kind of this.transformations) {
            const mapped = stringTypeMappingGet(mapping, kind);
            if (mapped === "string") return StringTypes.unrestricted;
            kinds.add(mapped);
        }

        return new StringTypes(this.cases, new Set(kinds));
    }

    public equals<T extends StringTypes>(other: T): boolean {
        if (!(other instanceof StringTypes)) return false;
        return (
            areEqual(this.cases, other.cases) &&
            areEqual(this.transformations, other.transformations)
        );
    }

    public hashCode(): number {
        let h = hashCodeOf(this.cases);
        h = addHashCode(h, hashCodeOf(this.transformations));
        return h;
    }

    public toString(): string {
        const parts: string[] = [];

        const enumCases = this.cases;
        if (enumCases === undefined) {
            parts.push("unrestricted");
        } else {
            const firstKey = iterableFirst(enumCases.keys());
            if (firstKey === undefined) {
                parts.push("enum with no cases");
            } else {
                parts.push(
                    `${enumCases.size.toString()} enums: ${firstKey} (${enumCases.get(firstKey)}), ...`,
                );
            }
        }

        return parts.concat(Array.from(this.transformations)).join(",");
    }
}

class StringTypesTypeAttributeKind extends TypeAttributeKind<StringTypes> {
    public constructor() {
        super("stringTypes");
    }

    public get inIdentity(): boolean {
        return true;
    }

    public requiresUniqueIdentity(st: StringTypes): boolean {
        return st.cases !== undefined && st.cases.size > 0;
    }

    public combine(arr: StringTypes[]): StringTypes {
        assert(arr.length > 0);
        return arr[0].union(arr, 1);
    }

    public intersect(arr: StringTypes[]): StringTypes {
        assert(arr.length > 0);
        return arr[0].intersect(arr, 1);
    }

    public makeInferred(_: StringTypes): undefined {
        return undefined;
    }

    public stringify(st: StringTypes): string {
        return st.toString();
    }
}

export const stringTypesTypeAttributeKind: TypeAttributeKind<StringTypes> =
    new StringTypesTypeAttributeKind();

const INTEGER_STRING = /^(0|-?[1-9]\d*)$/;
// We're restricting numbers to what's representable as 32 bit
// signed integers, to be on the safe side of most languages.
const MIN_INTEGER_STRING = 1 << 31;
const MAX_INTEGER_STRING = -(MIN_INTEGER_STRING + 1);

function isIntegerString(s: string): boolean {
    if (INTEGER_STRING.exec(s) === null) {
        return false;
    }

    const i = Number.parseInt(s, 10);
    return i >= MIN_INTEGER_STRING && i <= MAX_INTEGER_STRING;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isUUID(s: string): boolean {
    return UUID.exec(s) !== null;
}

// FIXME: This is obviously not a complete URI regex.  The exclusion of
// `{}` is a hack to make `github-events.json` work, which contains URLs
// with those characters which ajv refuses to accept as `uri`.
const URI = /^(https?|ftp):\/\/[^{}]+$/;

function isURI(s: string): boolean {
    return URI.exec(s) !== null;
}

/**
 * JSON inference calls this function to figure out whether a given string is to be
 * transformed into a higher level type.  Must return undefined if not, otherwise the
 * type kind of the transformed string type.
 *
 * @param s The string for which to determine the transformed string type kind.
 */
export function inferTransformedStringTypeKindForString(
    s: string,
    recognizer: DateTimeRecognizer,
): TransformedStringTypeKind | undefined {
    if (s.length === 0 || !"0123456789-abcdefth".includes(s[0]))
        return undefined;

    if (recognizer.isDate(s)) {
        return "date";
    }
    if (recognizer.isTime(s)) {
        return "time";
    }
    if (recognizer.isDateTime(s)) {
        return "date-time";
    }
    if (isIntegerString(s)) {
        return "integer-string";
    }
    if (s === "false" || s === "true") {
        return "bool-string";
    }
    if (isUUID(s)) {
        return "uuid";
    }
    if (isURI(s)) {
        return "uri";
    }

    return undefined;
}
