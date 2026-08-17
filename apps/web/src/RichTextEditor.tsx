import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Highlighter,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
  RemoveFormatting,
  Strikethrough,
  Underline
} from 'lucide-react';

export type RichTextEditorProps = {
  value: string;
  onChange: (html: string, text: string) => void;
  placeholder?: string;
  allowImages?: boolean;
  compact?: boolean;
  autoFocus?: boolean;
  onError?: (message: string) => void;
};

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_INLINE_IMAGE = 5 * 1024 * 1024;

function cleanPastedHtml(input: string): string {
  const parsed = new DOMParser().parseFromString(input, 'text/html');
  parsed.querySelectorAll('script,style,iframe,object,embed,form,input,button,textarea,select,option,svg,math,meta,link,base').forEach((node) => node.remove());
  parsed.body.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith('on') || name === 'srcdoc') element.removeAttribute(attribute.name);
      if ((name === 'href' || name === 'src') && (value.startsWith('javascript:') || value.startsWith('vbscript:'))) {
        element.removeAttribute(attribute.name);
      }
    }
  });
  return parsed.body.innerHTML;
}

function fileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Imagem inválida.'));
    reader.onerror = () => reject(reader.error || new Error('Não foi possível ler a imagem.'));
    reader.readAsDataURL(file);
  });
}

export default function RichTextEditor({
  value,
  onChange,
  placeholder = 'Escreva sua mensagem...',
  allowImages = true,
  compact = false,
  autoFocus = false,
  onError
}: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef<Range | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [empty, setEmpty] = useState(!value.replace(/<[^>]+>/g, '').trim());

  const emit = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const html = editor.innerHTML;
    const text = editor.innerText.replace(/\u00a0/g, ' ');
    setEmpty(!text.trim() && !editor.querySelector('img'));
    onChange(html, text);
  };

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.innerHTML !== value) {
      editor.innerHTML = value;
      setEmpty(!editor.innerText.trim() && !editor.querySelector('img'));
    }
  }, [value]);

  useEffect(() => {
    if (autoFocus) editorRef.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const rememberSelection = () => {
      const editor = editorRef.current;
      const selection = window.getSelection();
      if (!editor || !selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (editor.contains(range.commonAncestorContainer)) selectionRef.current = range.cloneRange();
    };
    document.addEventListener('selectionchange', rememberSelection);
    return () => document.removeEventListener('selectionchange', rememberSelection);
  }, []);

  const restoreSelection = () => {
    const selection = window.getSelection();
    if (!selectionRef.current || !selection) {
      editorRef.current?.focus();
      return;
    }
    editorRef.current?.focus();
    selection.removeAllRanges();
    selection.addRange(selectionRef.current);
  };

  const command = (name: string, commandValue?: string) => {
    restoreSelection();
    document.execCommand(name, false, commandValue);
    emit();
  };

  const insertHtml = (html: string) => {
    restoreSelection();
    document.execCommand('insertHTML', false, html);
    emit();
  };

  const addLink = () => {
    const href = window.prompt('Cole o endereço do link:');
    if (!href) return;
    const normalized = /^(https?:\/\/|mailto:)/i.test(href) ? href : `https://${href}`;
    command('createLink', normalized);
  };

  const addImageFile = async (file: File) => {
    if (!IMAGE_TYPES.has(file.type)) {
      onError?.('Use uma imagem PNG, JPG, GIF ou WebP.');
      return;
    }
    if (file.size > MAX_INLINE_IMAGE) {
      onError?.('Cada imagem inserida no corpo pode ter no máximo 5 MB.');
      return;
    }
    try {
      const src = await fileAsDataUrl(file);
      insertHtml(`<img src="${src}" alt="${file.name.replace(/[<>"']/g, '')}" style="max-width:100%;height:auto;display:block;margin:10px 0">`);
    } catch (error) {
      onError?.(error instanceof Error ? error.message : 'Não foi possível inserir a imagem.');
    }
  };

  const onPaste = async (event: ClipboardEvent<HTMLDivElement>) => {
    const image = Array.from(event.clipboardData.files).find((file) => IMAGE_TYPES.has(file.type));
    if (image && allowImages) {
      event.preventDefault();
      await addImageFile(image);
      return;
    }
    const html = event.clipboardData.getData('text/html');
    if (html) {
      event.preventDefault();
      insertHtml(cleanPastedHtml(html));
    }
  };

  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    if (!allowImages) return;
    const image = Array.from(event.dataTransfer.files).find((file) => IMAGE_TYPES.has(file.type));
    if (!image) return;
    event.preventDefault();
    await addImageFile(image);
  };

  const toolbarMouseDown = (event: ReactMouseEvent) => event.preventDefault();

  return (
    <div className={`rich-editor ${compact ? 'compact' : ''}`}>
      <div className="rich-toolbar" role="toolbar" aria-label="Formatação da mensagem">
        <select className="rich-format-select" defaultValue="div" onChange={(event) => command('formatBlock', event.target.value)} aria-label="Estilo do parágrafo">
          <option value="div">Normal</option>
          <option value="h1">Título</option>
          <option value="h2">Subtítulo</option>
          <option value="blockquote">Citação</option>
        </select>
        <span className="rich-toolbar-separator" />
        <button type="button" onMouseDown={toolbarMouseDown} onClick={() => command('bold')} title="Negrito"><Bold size={16} /></button>
        <button type="button" onMouseDown={toolbarMouseDown} onClick={() => command('italic')} title="Itálico"><Italic size={16} /></button>
        <button type="button" onMouseDown={toolbarMouseDown} onClick={() => command('underline')} title="Sublinhado"><Underline size={16} /></button>
        <button type="button" onMouseDown={toolbarMouseDown} onClick={() => command('strikeThrough')} title="Tachado"><Strikethrough size={16} /></button>
        <span className="rich-toolbar-separator" />
        <button type="button" onMouseDown={toolbarMouseDown} onClick={() => command('insertUnorderedList')} title="Lista"><List size={16} /></button>
        <button type="button" onMouseDown={toolbarMouseDown} onClick={() => command('insertOrderedList')} title="Lista numerada"><ListOrdered size={16} /></button>
        <button type="button" onMouseDown={toolbarMouseDown} onClick={() => command('formatBlock', 'blockquote')} title="Citação"><Quote size={16} /></button>
        <span className="rich-toolbar-separator" />
        <button type="button" onMouseDown={toolbarMouseDown} onClick={() => command('justifyLeft')} title="Alinhar à esquerda"><AlignLeft size={16} /></button>
        <button type="button" onMouseDown={toolbarMouseDown} onClick={() => command('justifyCenter')} title="Centralizar"><AlignCenter size={16} /></button>
        <button type="button" onMouseDown={toolbarMouseDown} onClick={() => command('justifyRight')} title="Alinhar à direita"><AlignRight size={16} /></button>
        <span className="rich-toolbar-separator" />
        <label className="rich-color-button" title="Cor do texto"><span><Highlighter size={14} /></span><input type="color" defaultValue="#e8e8eb" onChange={(event) => command('foreColor', event.target.value)} aria-label="Cor do texto" /></label>
        <label className="rich-color-button" title="Cor de destaque"><span className="highlight-swatch" /><input type="color" defaultValue="#fff3a3" onChange={(event) => command('hiliteColor', event.target.value)} aria-label="Cor de destaque" /></label>
        <button type="button" onMouseDown={toolbarMouseDown} onClick={addLink} title="Inserir link"><Link2 size={16} /></button>
        {allowImages && <button type="button" onMouseDown={toolbarMouseDown} onClick={() => imageInputRef.current?.click()} title="Inserir imagem no corpo"><ImagePlus size={16} /></button>}
        <button type="button" onMouseDown={toolbarMouseDown} onClick={() => command('removeFormat')} title="Limpar formatação"><RemoveFormatting size={16} /></button>
      </div>
      <div className="rich-editor-surface-wrap">
        {empty && <span className="rich-editor-placeholder">{placeholder}</span>}
        <div
          ref={editorRef}
          className="rich-editor-surface"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          onInput={emit}
          onPaste={(event) => void onPaste(event)}
          onDrop={(event) => void onDrop(event)}
        />
      </div>
      {allowImages && <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void addImageFile(file); event.currentTarget.value = ''; }} />}
    </div>
  );
}
