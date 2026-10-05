import {
  ImageAlignment,
  PDFButton,
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFField,
  PDFFont,
  PDFImage,
  PDFOptionList,
  PDFPage,
  PDFRadioGroup,
  PDFTextField,
  TextAlignment,
  degrees,
  type Color,
} from "@cantoo/pdf-lib";
import { z } from "zod";
import { badRequest } from "./errors";

export const Alignment = z.enum(["left", "center", "right"]);
const ALIGN = { left: TextAlignment.Left, center: TextAlignment.Center, right: TextAlignment.Right } as const;
const IMAGE_ALIGN = { left: ImageAlignment.Left, center: ImageAlignment.Center, right: ImageAlignment.Right } as const;

export const FIELD_EVENTS = [
  "keystroke",
  "format",
  "validate",
  "calculate",
  "mouseUp",
  "mouseDown",
  "mouseEnter",
  "mouseExit",
  "focus",
  "blur",
] as const;

/** Settings that can be given when creating a field or changed later. */
export const fieldSettings = {
  readOnly: z.boolean().optional(),
  required: z.boolean().optional(),
  /** false keeps the field's value out of form submissions. */
  exported: z.boolean().optional(),
  // text fields
  multiline: z.boolean().optional(),
  /** null removes the limit. */
  maxLength: z.number().int().positive().nullable().optional(),
  alignment: Alignment.optional(),
  /** 0 = auto-size. Text fields, dropdowns, option lists, buttons. */
  fontSize: z.number().nonnegative().optional(),
  password: z.boolean().optional(),
  /** Spreads characters evenly over maxLength boxes (needs maxLength). */
  comb: z.boolean().optional(),
  spellCheck: z.boolean().optional(),
  scroll: z.boolean().optional(),
  richText: z.boolean().optional(),
  fileSelect: z.boolean().optional(),
  // dropdowns and option lists
  options: z.array(z.string()).optional(),
  editable: z.boolean().optional(),
  sort: z.boolean().optional(),
  multiselect: z.boolean().optional(),
  selectOnClick: z.boolean().optional(),
  // radio groups
  /** Clicking the selected option clears it. */
  offToggle: z.boolean().optional(),
  /** Options with the same value turn on together. false makes them independent. */
  mutuallyExclusive: z.boolean().optional(),
};
type Settings = { [K in keyof typeof fieldSettings]?: z.infer<(typeof fieldSettings)[K]> };

const toggle = (on: boolean | undefined, enable: () => void, disable: () => void) => on !== undefined && (on ? enable() : disable());

/** Applies settings, failing on ones that do not fit the field's type. */
export function applySettings(field: PDFField, s: Settings) {
  const name = field.getName();
  const wrong = (key: string) => {
    throw badRequest(`"${key}" does not apply to ${field.constructor.name.replace(/^PDF/, "")} field "${name}"`);
  };
  toggle(s.readOnly, () => field.enableReadOnly(), () => field.disableReadOnly());
  toggle(s.required, () => field.enableRequired(), () => field.disableRequired());
  toggle(s.exported, () => field.enableExporting(), () => field.disableExporting());

  const textOnly = ["multiline", "maxLength", "alignment", "password", "comb", "spellCheck", "scroll", "richText", "fileSelect"] as const;
  if (field instanceof PDFTextField) {
    toggle(s.multiline, () => field.enableMultiline(), () => field.disableMultiline());
    if (s.maxLength === null) field.removeMaxLength();
    else if (s.maxLength !== undefined) field.setMaxLength(s.maxLength);
    if (s.alignment) field.setAlignment(ALIGN[s.alignment]);
    toggle(s.password, () => field.enablePassword(), () => field.disablePassword());
    toggle(s.comb, () => field.enableCombing(), () => field.disableCombing());
    toggle(s.spellCheck, () => field.enableSpellChecking(), () => field.disableSpellChecking());
    toggle(s.scroll, () => field.enableScrolling(), () => field.disableScrolling());
    toggle(s.richText, () => field.enableRichFormatting(), () => field.disableRichFormatting());
    toggle(s.fileSelect, () => field.enableFileSelection(), () => field.disableFileSelection());
  } else {
    for (const k of textOnly) if (s[k] !== undefined) wrong(k);
  }

  if (s.fontSize !== undefined) {
    if (field instanceof PDFTextField || field instanceof PDFDropdown || field instanceof PDFOptionList || field instanceof PDFButton) field.setFontSize(s.fontSize);
    else wrong("fontSize");
  }

  if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    if (s.options) field.setOptions(s.options);
    toggle(s.sort, () => field.enableSorting(), () => field.disableSorting());
    toggle(s.multiselect, () => field.enableMultiselect(), () => field.disableMultiselect());
    toggle(s.selectOnClick, () => field.enableSelectOnClick(), () => field.disableSelectOnClick());
    if (field instanceof PDFDropdown) toggle(s.editable, () => field.enableEditing(), () => field.disableEditing());
    else if (s.editable !== undefined) wrong("editable");
  } else {
    for (const k of ["options", "sort", "multiselect", "selectOnClick", "editable"] as const) if (s[k] !== undefined) wrong(k);
  }

  if (field instanceof PDFRadioGroup) {
    toggle(s.offToggle, () => field.enableOffToggling(), () => field.disableOffToggling());
    toggle(s.mutuallyExclusive, () => field.enableMutualExclusion(), () => field.disableMutualExclusion());
  } else {
    for (const k of ["offToggle", "mutuallyExclusive"] as const) if (s[k] !== undefined) wrong(k);
  }
}

/** Shows an image in a text field or button (e.g. a signature or photo box). */
export function setFieldImage(field: PDFField, image: PDFImage, alignment: z.infer<typeof Alignment> = "center") {
  if (field instanceof PDFTextField) field.setImage(image);
  else if (field instanceof PDFButton) field.setImage(image, IMAGE_ALIGN[alignment]);
  else throw badRequest(`Field "${field.getName()}" cannot show an image (only text fields and buttons can)`);
}

export interface Widget {
  page: PDFPage;
  x: number;
  y: number;
  width: number;
  height: number;
  textColor?: Color;
  backgroundColor?: Color;
  borderColor?: Color;
  borderWidth?: number;
  rotate?: number;
  font?: PDFFont;
  hidden?: boolean;
}

const appearance = ({ page: _page, rotate, ...rest }: Widget) => ({ ...rest, rotate: rotate === undefined ? undefined : degrees(rotate) });

export type NewField =
  | { type: "text"; value?: string }
  | { type: "checkbox"; checked?: boolean }
  | { type: "dropdown" | "optionList"; options: string[]; selected?: string | string[] }
  | { type: "radio"; options: { value: string; widget: Widget }[]; selected?: string }
  | { type: "button"; label: string };

/** Creates a form field and puts it on the page(s). */
export function createField(doc: PDFDocument, name: string, spec: NewField, widget: Widget | undefined): PDFField {
  const form = doc.getForm();
  if (form.getFieldMaybe(name)) throw badRequest(`A form field named "${name}" already exists`);
  const need = () => {
    if (!widget) throw badRequest(`Field "${name}" needs page, x, y, width and height`);
    return widget;
  };
  switch (spec.type) {
    case "text": {
      const f = form.createTextField(name);
      if (spec.value !== undefined) f.setText(spec.value);
      f.addToPage(need().page, appearance(need()));
      return f;
    }
    case "checkbox": {
      const f = form.createCheckBox(name);
      f.addToPage(need().page, appearance(need()));
      if (spec.checked) f.check();
      return f;
    }
    case "dropdown":
    case "optionList": {
      const f = spec.type === "dropdown" ? form.createDropdown(name) : form.createOptionList(name);
      f.addOptions(spec.options);
      if (spec.selected !== undefined) f.select(spec.selected);
      f.addToPage(need().page, appearance(need()));
      return f;
    }
    case "radio": {
      if (!spec.options.length) throw badRequest(`Radio group "${name}" needs at least one option`);
      const f = form.createRadioGroup(name);
      for (const o of spec.options) f.addOptionToPage(o.value, o.widget.page, appearance(o.widget));
      if (spec.selected !== undefined) f.select(spec.selected);
      return f;
    }
    case "button": {
      const f = form.createButton(name);
      f.addToPage(spec.label, need().page, appearance(need()));
      return f;
    }
  }
}

/** Replaces the script of an existing field action (the library cannot add new ones). */
export function setFieldScript(field: PDFField, event: (typeof FIELD_EVENTS)[number], script: string) {
  const action = field.getJavaScriptActions()?.[event];
  if (!action) {
    throw badRequest(`Field "${field.getName()}" has no "${event}" script to change. List existing scripts with /pdf/scripts.`);
  }
  action.setScript(script);
}

/** A field's settings, for /pdf/info. */
export function describeField(f: PDFField) {
  const out: Record<string, unknown> = { readOnly: f.isReadOnly(), required: f.isRequired(), exported: f.isExported() };
  if (f instanceof PDFTextField) {
    Object.assign(out, {
      multiline: f.isMultiline(),
      maxLength: f.getMaxLength() ?? null,
      alignment: (["left", "center", "right"] as const)[f.getAlignment()],
      password: f.isPassword(),
      comb: f.isCombed(),
    });
  }
  if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
    Object.assign(out, { multiselect: f.isMultiselect(), sort: f.isSorted() });
    if (f instanceof PDFDropdown) out.editable = f.isEditable();
  }
  if (f instanceof PDFRadioGroup) Object.assign(out, { offToggle: f.isOffToggleable(), mutuallyExclusive: f.isMutuallyExclusive() });
  if (f instanceof PDFCheckBox) out.checked = f.isChecked();
  return out;
}
