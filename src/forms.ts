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
import type { FieldSettings } from "./replies";

export const Alignment = z.enum(["left", "center", "right"]).meta({ id: "Alignment", description: "Horizontal alignment." });
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

/** Settings that can be given when creating a field or changed later. A setting that doesn't fit the field's type is an error. */
export const fieldSettings = {
  readOnly: z.boolean().optional(),
  required: z.boolean().optional(),
  exported: z.boolean().optional().describe("false keeps the field's value out of form submissions."),
  multiline: z.boolean().optional().describe("Text fields."),
  maxLength: z.number().int().positive().nullable().optional().describe("Text fields: maximum characters; null removes the limit."),
  alignment: Alignment.optional().describe("Text fields."),
  fontSize: z.number().nonnegative().optional().describe("Text fields, dropdowns, option lists and buttons. 0 = auto-size."),
  password: z.boolean().optional().describe("Text fields: hide the characters typed."),
  comb: z.boolean().optional().describe("Text fields: one character per box across the field's width (needs maxLength)."),
  spellCheck: z.boolean().optional().describe("Text fields and dropdowns."),
  scroll: z.boolean().optional().describe("Text fields: allow text longer than the box."),
  richText: z.boolean().optional().describe("Text fields."),
  fileSelect: z.boolean().optional().describe("Text fields: the value is a file path."),
  options: z.array(z.string()).optional().describe("Dropdowns and option lists: the choices."),
  editable: z.boolean().optional().describe("Dropdowns: allow typing a value not in the list."),
  sort: z.boolean().optional().describe("Dropdowns and option lists."),
  multiselect: z.boolean().optional().describe("Dropdowns and option lists."),
  selectOnClick: z.boolean().optional().describe("Dropdowns and option lists: commit the choice as soon as it is clicked."),
  offToggle: z.boolean().optional().describe("Radio groups: clicking the selected option clears it."),
  mutuallyExclusive: z
    .boolean()
    .optional()
    .describe("Radio groups, addFormField only: true (default) turns on one button at a time; false turns on every button sharing the chosen value."),
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
  | { type: "radio"; options: { value: string; widget: Widget }[]; selected?: string; mutuallyExclusive?: boolean }
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
      // Decides how each button is wired as it is added, so it must come first.
      if (spec.mutuallyExclusive === false) f.disableMutualExclusion();
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
export function describeField(f: PDFField): FieldSettings {
  const out: FieldSettings = { readOnly: f.isReadOnly(), required: f.isRequired(), exported: f.isExported() };
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
