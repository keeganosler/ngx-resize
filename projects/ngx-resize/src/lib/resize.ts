import { DOCUMENT } from '@angular/common';
import {
    Directive,
    ElementRef,
    EventEmitter,
    Inject,
    inject,
    InjectionToken,
    InjectOptions,
    Input,
    NgZone,
    OnDestroy,
    OnInit,
    Output,
} from '@angular/core';
import {
    debounceTime,
    fromEvent,
    MonoTypeOperatorFunction,
    Observable,
    pipe,
    ReplaySubject,
    share,
    Subscription,
    takeUntil,
} from 'rxjs';

export interface NgxResizeOptions {
    box: ResizeObserverBoxOptions;
    debounce: number | { scroll: number; resize: number };
    scroll: boolean;
    offsetSize: boolean;
}

export const defaultResizeOptions: NgxResizeOptions = {
    box: 'content-box',
    scroll: false,
    offsetSize: false,
    debounce: { scroll: 50, resize: 0 },
};

export const NGX_RESIZE_OPTIONS = new InjectionToken<NgxResizeOptions>(
    'NgxResizeOptions',
    { factory: () => defaultResizeOptions }
);

export function injectNgxResizeOptions(): NgxResizeOptions;
export function injectNgxResizeOptions(
    options: InjectOptions & { optional?: false }
): NgxResizeOptions;
export function injectNgxResizeOptions(
    options: InjectOptions & { optional?: true }
): NgxResizeOptions | null;
export function injectNgxResizeOptions(options?: InjectOptions) {
    return inject(NGX_RESIZE_OPTIONS, options || {});
}

export function provideNgxResizeOptions(
    options: Partial<NgxResizeOptions> = {}
) {
    return {
        provide: NGX_RESIZE_OPTIONS,
        useValue: { ...defaultResizeOptions, ...options },
    };
}

export interface NgxResizeResult {
    readonly entries: ReadonlyArray<ResizeObserverEntry>;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
    readonly dpr: number;
}

export function injectNgxResize(
    options: Partial<NgxResizeOptions> = {}
): Observable<NgxResizeResult> {
    const { nativeElement } = inject(ElementRef) as ElementRef<HTMLElement>;
    const zone = inject(NgZone);
    const document = inject(DOCUMENT);

    const globalOptions = injectNgxResizeOptions();
    const mergedOptions = { ...globalOptions, ...options };

    return createResizeStream(mergedOptions, nativeElement, document, zone);
}

@Directive({ selector: '[ngxResize]', standalone: true })
export class NgxResize implements OnInit, OnDestroy {
    @Input() ngxResizeOptions: Partial<NgxResizeOptions> = {};
    @Output() ngxResize = new EventEmitter<NgxResizeResult>();

    constructor(
        private readonly host: ElementRef<HTMLElement>,
        private readonly zone: NgZone,
        @Inject(DOCUMENT) private readonly document: Document,
        @Inject(NGX_RESIZE_OPTIONS)
        private readonly resizeOptions: NgxResizeOptions
    ) {}

    private sub?: Subscription;

    ngOnInit() {
        const mergedOptions = {
            ...this.resizeOptions,
            ...this.ngxResizeOptions,
        };
        this.sub = createResizeStream(
            mergedOptions,
            this.host.nativeElement,
            this.document,
            this.zone
        ).subscribe(this.ngxResize);
    }

    ngOnDestroy() {
        this.sub?.unsubscribe();
    }
}

// return ResizeResult observable
function createResizeStream(
    { debounce, scroll, offsetSize, box }: NgxResizeOptions,
    nativeElement: HTMLElement,
    document: Document,
    zone: NgZone
) {
    const window = document.defaultView;
    const isSupport = !!window?.ResizeObserver;

    let observer: ResizeObserver;
    let lastBounds: Omit<NgxResizeResult, 'entries' | 'dpr'>;
    let lastEntries: ResizeObserverEntry[] = [];

    const torndown$ = new ReplaySubject<void>();
    const scrollContainers: HTMLOrSVGElement[] | null = findScrollContainers(
        nativeElement,
        document.body
    );

    // set actual debounce values early, so effects know if they should react accordingly
    const scrollDebounce = debounce
        ? typeof debounce === 'number'
            ? debounce
            : debounce.scroll
        : null;

    const resizeDebounce = debounce
        ? typeof debounce === 'number'
            ? debounce
            : debounce.resize
        : null;

    const debounceAndTorndown = <T>(
        debounce: number | null
    ): MonoTypeOperatorFunction<T> => {
        return pipe(debounceTime(debounce ?? 0), takeUntil(torndown$));
    };

    return new Observable<NgxResizeResult>((subscriber) => {
        if (!isSupport) {
            subscriber.error(
                '[ngx-resize] your browser does not support ResizeObserver. Please consider using a polyfill'
            );
            return;
        }

        zone.runOutsideAngular(() => {
            const callback = (entries: ResizeObserverEntry[]) => {
                lastEntries = entries;
                const { left, top, width, height, bottom, right, x, y } =
                    nativeElement.getBoundingClientRect();
                const size = {
                    left,
                    top,
                    width,
                    height,
                    bottom,
                    right,
                    x,
                    y,
                };

                if (nativeElement instanceof HTMLElement && offsetSize) {
                    size.height = nativeElement.offsetHeight;
                    size.width = nativeElement.offsetWidth;
                }

                Object.freeze(size);
                subscriber.next({
                    entries,
                    dpr: window.devicePixelRatio,
                    ...size,
                });

                if (!areBoundsEqual(lastBounds || {}, size)) {
                    lastBounds = size;
                }
            };

            const boundCallback = () => {
                callback(lastEntries);
            };

            observer = new ResizeObserver(callback);

            observer.observe(nativeElement, { box });
            if (scroll) {
                if (scrollContainers) {
                    scrollContainers.forEach((scrollContainer) => {
                        fromEvent(scrollContainer as HTMLElement, 'scroll', {
                            capture: true,
                            passive: true,
                        })
                            .pipe(debounceAndTorndown(scrollDebounce))
                            .subscribe(boundCallback);
                    });
                }

                fromEvent(window, 'scroll', { capture: true, passive: true })
                    .pipe(debounceAndTorndown(scrollDebounce))
                    .subscribe(boundCallback);
            }

            fromEvent(window, 'resize')
                .pipe(debounceAndTorndown(resizeDebounce))
                .subscribe(boundCallback);
        });

        return () => {
            if (observer) {
                observer.unobserve(nativeElement);
                observer.disconnect();
            }
            torndown$.next();
            torndown$.complete();
        };
    }).pipe(
        debounceTime(scrollDebounce ?? 0),
        share({
            connector: () => new ReplaySubject(1),
            resetOnRefCountZero: true,
            resetOnComplete: true,
            resetOnError: true,
        })
    );
}

// Returns a list of scroll offsets
function findScrollContainers(
    element: HTMLOrSVGElement | null,
    documentBody: HTMLElement
): HTMLOrSVGElement[] {
    const result: HTMLOrSVGElement[] = [];
    if (!element || element === documentBody) return result;
    const { overflow, overflowX, overflowY } = window.getComputedStyle(
        element as HTMLElement
    );
    if (
        [overflow, overflowX, overflowY].some(
            (prop) => prop === 'auto' || prop === 'scroll'
        )
    )
        result.push(element);
    return [
        ...result,
        ...findScrollContainers(
            (element as HTMLElement).parentElement,
            documentBody
        ),
    ];
}

// Checks if element boundaries are equal
const keys: (keyof Omit<NgxResizeResult, 'entries' | 'dpr'>)[] = [
    'x',
    'y',
    'top',
    'bottom',
    'left',
    'right',
    'width',
    'height',
];
const areBoundsEqual = (
    a: Omit<NgxResizeResult, 'entries' | 'dpr'>,
    b: Omit<NgxResizeResult, 'entries' | 'dpr'>
) => keys.every((key) => a[key] === b[key]);
