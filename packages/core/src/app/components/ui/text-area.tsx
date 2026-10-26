import {
	type ComponentProps,
	forwardRef,
	type RefObject,
	useId,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
} from "react";
import { FieldOutline } from "./field-outline";
import { cn } from "./utils";

interface TextAreaProps extends Omit<ComponentProps<"textarea">, "id" | "placeholder"> {
	label: string;
	error?: string;
	/** Grow with the content from `rows` up to a capped height, then scroll. */
	autoGrow?: boolean;
}

function fitToContent(el: HTMLTextAreaElement) {
	// Pin the wrapper so collapsing the textarea to measure can't clamp an ancestor's scroll.
	const wrap = el.parentElement;
	if (wrap) wrap.style.minHeight = `${wrap.offsetHeight}px`;
	// No scrollbar while measuring: it would narrow the text and overstate the height.
	el.style.overflowY = "hidden";
	el.style.height = "auto";
	const content = el.scrollHeight;
	// 0 when not laid out (display: none); the ResizeObserver refits once shown.
	if (content) {
		el.style.height = `${content}px`;
		if (content > Number.parseFloat(getComputedStyle(el).maxHeight)) el.style.overflowY = "auto";
	}
	if (wrap) wrap.style.minHeight = "";
}

// JS, not CSS `field-sizing`: our minimum Chromium (116), Firefox (128) and older WebKit lack it.
function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, enabled: boolean) {
	useLayoutEffect(() => {
		const el = ref.current;
		if (!enabled || !el) return;
		const refit = () => fitToContent(el);
		// react-hook-form's register, reset and setValue assign el.value without an input event.
		const own = Object.getOwnPropertyDescriptor(el, "value");
		const base = own ?? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
		Object.defineProperty(el, "value", {
			configurable: true,
			get: () => base?.get?.call(el),
			set: (value: string) => {
				base?.set?.call(el, value);
				refit();
			},
		});
		// Width or viewport changes rewrap or reclamp it; deferred so the resize can't loop the observer.
		let frame = 0;
		const observer = new ResizeObserver(() => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(refit);
		});
		observer.observe(el);
		el.addEventListener("input", refit);
		refit();
		return () => {
			el.removeEventListener("input", refit);
			observer.disconnect();
			cancelAnimationFrame(frame);
			if (own) Object.defineProperty(el, "value", own);
			else Reflect.deleteProperty(el, "value");
		};
	}, [ref, enabled]);
}

/** Multi-line text field (same fieldset+legend pattern as TextField), with a top-pinned label. */
export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
	{ label, error, className, disabled, rows = 3, autoGrow = false, ...props },
	ref,
) {
	const id = useId();
	const invalid = Boolean(error);
	const inner = useRef<HTMLTextAreaElement>(null);
	useImperativeHandle(ref, () => inner.current as HTMLTextAreaElement, []);
	useAutoGrow(inner, autoGrow);
	return (
		<div>
			<div className="group relative">
				<textarea
					ref={inner}
					id={id}
					rows={rows}
					disabled={disabled}
					placeholder=" "
					aria-invalid={invalid || undefined}
					className={cn(
						"peer relative block w-full appearance-none bg-transparent",
						"px-3 pt-3 pb-3 text-sm text-foreground resize-none",
						"placeholder-transparent outline-none",
						"disabled:opacity-50 disabled:cursor-not-allowed",
						autoGrow && "max-h-[60vh]",
						className,
					)}
					{...props}
				/>
				<FieldOutline label={label} invalid={invalid} notch="textarea" />
				<label
					htmlFor={id}
					className={cn(
						"pointer-events-none absolute left-3 top-3 origin-[0]",
						"text-sm text-muted-foreground transition-all duration-150",
						"peer-focus:top-0 peer-focus:-translate-y-1/2 peer-focus:scale-75 peer-focus:text-primary",
						"peer-[:not(:placeholder-shown)]:top-0 peer-[:not(:placeholder-shown)]:-translate-y-1/2 peer-[:not(:placeholder-shown)]:scale-75",
						invalid && "text-destructive peer-focus:text-destructive",
					)}
				>
					{label}
				</label>
			</div>
			{error && <p className="text-xs text-destructive mt-1">{error}</p>}
		</div>
	);
});
