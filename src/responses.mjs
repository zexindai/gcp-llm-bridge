import { randomUUID } from 'node:crypto';
import { citations, searchEvidence, webSearchItem, validateSearchOptions, functionName } from './search.mjs';
import { ResponsesError } from './responses-error.mjs';
import { sealProviderState, openProviderState, providerCallId, restoreProviderCall } from './provider-state.mjs';
import { object } from './utils.mjs';
export { ResponsesError } from './responses-error.mjs';

const id = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;

function requireValue(condition, message, param) {
  if (!condition) throw new ResponsesError(message, param);
}

function string(value, param) {
  requireValue(typeof value === 'string', 'Expected a string.', param);
  return value;
}

const applyPatchInstructions = `Codex apply_patch format requirements:
Put the complete raw patch in the input string of this function's JSON arguments. JSON-escape that string normally. Do not put a JSON object, a shell command, or Markdown fences inside input.
Begin with *** Begin Patch and finish with *** End Patch, each on its own line.
For an existing file, use *** Update File: path, followed by a bare @@ hunk separator. An optional @@ context heading must be literal text that exists in the file, not line numbers.
Use Codex patch syntax rather than standard unified diff: omit hunk line numbers and --- or +++ file headers.
Within an update hunk, prefix unchanged context lines with one space, removed lines with -, and added lines with +. Include these prefixes on empty lines too. Copy context exactly from the current file. Prefer small, focused hunks; re-read the file after a context mismatch before retrying.
For a new file, use *** Add File: path and prefix every file-content line with +; do not use @@. For deletion, use *** Delete File: path without hunks. For a rename, place *** Move to: new_path immediately after *** Update File: old_path, before any hunks. The optional *** End of File marker belongs at the end of the last update hunk, before *** End Patch.`;

function customToolDescription(tool) {
  const definition = JSON.stringify(tool, (_key, value) => object(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  return `Pass the original tool's raw input as the input string in this function's JSON arguments. Follow the original tool definition, including its format and grammar.\n\n${applyPatchInstructions}\n\nOriginal tool definition:\n\`\`\`json\n${definition}\n\`\`\``;
}

function content(value, param, images = true) {
  if (typeof value === 'string') return value;
  requireValue(Array.isArray(value), 'Expected a string or a list of content parts.', param);
  return value.map((part, index) => {
    const path = `${param}[${index}]`;
    requireValue(object(part), 'Expected a content part.', path);
    if (['input_text', 'output_text'].includes(part.type)) return { type: 'text', text: string(part.text, `${path}.text`) };
    if (part.type === 'input_image') {
      requireValue(images, 'Images are not supported in assistant messages.', path);
      requireValue(!part.file_id && typeof part.image_url === 'string' && /^(https?:\/\/|data:image\/)/.test(part.image_url),
        'Images require an http(s) or data image_url; uploaded file IDs are not supported.', path);
      if (part.detail !== undefined) requireValue(['auto', 'low', 'high', 'original'].includes(part.detail), 'Invalid image detail.', `${path}.detail`);
      return { type: 'image_url', image_url: { url: part.image_url, ...(part.detail ? { detail: part.detail } : {}) } };
    }
    throw new ResponsesError('Unsupported content part type.', `${path}.type`, 'unsupported_parameter');
  });
}

const parts = value => typeof value === 'string' ? [{ type: 'text', text: value }] : value ?? [];
function appendContent(message, value) {
  if (message.content == null) message.content = value;
  else if (typeof message.content === 'string' && typeof value === 'string') message.content += value;
  else message.content = [...parts(message.content), ...parts(value)];
}

// Provider extensions (notably Google's thought signatures) must survive history replay.
function mergeExtra(a, b) {
  if (!object(b)) return a;
  return Object.fromEntries([...new Set([...Object.keys(object(a) ? a : {}), ...Object.keys(b)])].map(key => {
    const previous = object(a) && Object.hasOwn(a, key) ? a[key] : undefined;
    const next = Object.hasOwn(b, key) ? b[key] : undefined;
    return [key, object(next) ? mergeExtra(previous, next) : next ?? previous];
  }));
}

export function toChatRequest(body, providerKey) {
  requireValue(object(body), 'Expected a JSON object.', null);
  requireValue(typeof body.model === 'string' && body.model.length > 0, 'model is required.', 'model');
  requireValue(body.input !== undefined || typeof body.instructions === 'string', 'input or instructions is required.', 'input');
  for (const name of ['previous_response_id', 'conversation']) {
    if (body[name] != null) throw new ResponsesError('This endpoint is stateless; send the full history in input.', name, 'unsupported_parameter');
  }
  if (body.background === true) throw new ResponsesError('Background responses are not supported.', 'background', 'unsupported_parameter');
  if (body.stream !== undefined) requireValue(typeof body.stream === 'boolean', 'stream must be a boolean.', 'stream');
  if (body.parallel_tool_calls !== undefined) requireValue(typeof body.parallel_tool_calls === 'boolean', 'parallel_tool_calls must be a boolean.', 'parallel_tool_calls');
  if (body.max_output_tokens !== undefined) requireValue(Number.isSafeInteger(body.max_output_tokens) && body.max_output_tokens > 0, 'Expected a positive integer.', 'max_output_tokens');

  const messages = [];
  if (body.instructions != null) messages.push({ role: 'system', content: string(body.instructions, 'instructions') });
  const assistant = () => {
    if (messages.at(-1)?.role !== 'assistant') messages.push({ role: 'assistant', content: null });
    return messages.at(-1);
  };
  const pending = new Map();
  const callIds = new Set();
  const items = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input ?? [];
  requireValue(Array.isArray(items), 'input must be a string or a list of items.', 'input');
  for (const [index, item] of items.entries()) {
    const path = `input[${index}]`;
    requireValue(object(item), 'Expected an input item.', path);
    const type = item.type ?? 'message';
    if (type === 'message') {
      requireValue(['user', 'assistant', 'system', 'developer'].includes(item.role), 'Invalid message role.', `${path}.role`);
      const value = content(item.content, `${path}.content`, item.role !== 'assistant');
      const message = item.role === 'assistant' ? assistant() : { role: item.role === 'developer' ? 'system' : item.role, content: null };
      appendContent(message, value);
      if (item.extra_content) message.extra_content = mergeExtra(message.extra_content, item.extra_content);
      if (item.role !== 'assistant') messages.push(message);
    } else if (type === 'reasoning') {
      const text = typeof item.content === 'string' ? item.content : (Array.isArray(item.content) ? item.content : [])
        .filter(part => part?.type === 'reasoning_text').map(part => string(part.text, `${path}.content`)).join('');
      if (text) assistant().reasoning_content = (assistant().reasoning_content ?? '') + text;
    } else if (type === 'function_call' || type === 'custom_tool_call') {
      const callId = string(item.call_id, `${path}.call_id`);
      requireValue(callId.length > 0 && !callIds.has(callId), 'Tool call IDs must be nonempty and unique.', `${path}.call_id`);
      const name = string(item.name, `${path}.name`);
      if (item.namespace != null) requireValue(typeof item.namespace === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(item.namespace), 'Invalid tool namespace.', `${path}.namespace`);
      if (type === 'custom_tool_call') requireValue(name === 'apply_patch', 'Only the apply_patch custom tool is supported.', `${path}.name`);
      const args = type === 'custom_tool_call' ? JSON.stringify({ input: string(item.input, `${path}.input`) }) : string(item.arguments, `${path}.arguments`);
      const wireName = functionName(name, item.namespace);
      const restored = restoreProviderCall(callId, { key: providerKey, model: body.model, name: wireName });
      const call = { id: restored.callId, type: 'function', function: { name: wireName, arguments: args } };
      if (restored.extra) call.extra_content = restored.extra;
      else if (item.encrypted_content != null) call.extra_content = openProviderState(item.encrypted_content,
        { key: providerKey, model: body.model, callId, name: call.function.name });
      else if (item.extra_content) call.extra_content = item.extra_content;
      (assistant().tool_calls ??= []).push(call);
      callIds.add(callId);
      pending.set(callId, { type, upstreamId: call.id });
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      if (type === 'function_call_output' && item.call_id == null && item.name != null) {
        const name = string(item.name, `${path}.name`);
        requireValue(/^[a-zA-Z0-9_-]{1,64}$/.test(name), 'Invalid context tool name.', `${path}.name`);
        if (item.namespace != null) requireValue(typeof item.namespace === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(item.namespace), 'Invalid tool namespace.', `${path}.namespace`);
        const label = item.namespace ? `${item.namespace}.${name}` : name;
        messages.push({ role: 'user', content: [{ type: 'text', text: `Tool context (${label}):\n` },
          ...parts(content(item.output, `${path}.output`))] });
        continue;
      }
      const callId = string(item.call_id, `${path}.call_id`);
      requireValue(pending.get(callId)?.type === type.replace('_output', ''), 'Tool output requires a matching, unanswered call_id.', `${path}.call_id`);
      messages.push({ role: 'tool', tool_call_id: pending.get(callId).upstreamId, content: content(item.output, `${path}.output`) });
      pending.delete(callId);
    }
    // Ignore unsupported item types, as in the DeepSeek compatibility API.
  }
  requireValue(pending.size === 0, 'Every input tool call must have a matching tool output.', 'input');
  requireValue(messages.length > 0, 'At least one message is required.', 'input');

  const customTools = new Set();
  const toolNames = new Map();
  const tools = [];
  const searchTools = [];
  const names = new Set();
  if (body.tools !== undefined) {
    requireValue(Array.isArray(body.tools), 'tools must be a list.', 'tools');
    const flattened = body.tools.flatMap((tool, index) => {
      if (tool?.type !== 'namespace') return [{ tool, path: `tools[${index}]` }];
      const namespace = string(tool.name, `tools[${index}].name`);
      requireValue(/^[a-zA-Z0-9_-]{1,64}$/.test(namespace) && Array.isArray(tool.tools), 'Invalid tool namespace.', `tools[${index}]`);
      return tool.tools.map((child, childIndex) => ({ tool: child, namespace, path: `tools[${index}].tools[${childIndex}]` }));
    });
    for (const { tool, namespace, path } of flattened) {
      requireValue(object(tool), 'Expected a tool definition.', path);
      if (['web_search', 'web_search_preview', 'web_search_preview_2025_03_11'].includes(tool.type)) {
        requireValue(!namespace, 'Hosted web search cannot be nested in a namespace.', path);
        validateSearchOptions(tool, path);
        searchTools.push(tool);
        continue;
      }
      if (!['function', 'custom'].includes(tool.type)) continue;
      const originalName = string(tool.name, `${path}.name`);
      const name = functionName(originalName, namespace);
      requireValue(/^[a-zA-Z0-9_-]{1,64}$/.test(originalName) && !names.has(name), 'Tool names must be valid and unique.', `${path}.name`);
      names.add(name);
      if (namespace) toolNames.set(name, { name: originalName, namespace });
      if (tool.type === 'custom') {
        requireValue(originalName === 'apply_patch', 'Only the apply_patch custom tool is supported.', `${path}.name`);
        customTools.add(name);
        tools.push({ type: 'function', function: { name,
          description: customToolDescription(tool),
          parameters: { type: 'object', properties: { input: { type: 'string',
            description: 'The complete raw Codex patch, from *** Begin Patch to *** End Patch. Preserve whitespace, line breaks, and formatting. Use bare @@ hunk separators or literal context headings without line numbers. Follow the original tool format and grammar. Do not include Markdown fences, shell commands, or another JSON wrapper in this string.' } }, required: ['input'], additionalProperties: false }, strict: true } });
      } else {
        const fn = { name };
        for (const field of ['description', 'parameters', 'strict']) if (tool[field] !== undefined) fn[field] = tool[field];
        tools.push({ type: 'function', function: fn });
      }
    }
  }
  const chat = { model: body.model, messages, stream: body.stream ?? false };
  const searchEnabled = searchTools.length > 0 && body.tool_choice !== 'none'
    && !(object(body.tool_choice) && ['function', 'custom'].includes(body.tool_choice.type));
  if (searchEnabled) chat.web_search_options = {};
  if (tools.length) chat.tools = tools;
  for (const [name, max] of [['temperature', 2], ['top_p', 1]]) {
    if (body[name] != null) requireValue(typeof body[name] === 'number' && Number.isFinite(body[name]) && body[name] >= 0 && body[name] <= max,
      `Expected a number between 0 and ${max}.`, name);
  }
  if (body.top_logprobs != null) requireValue(Number.isSafeInteger(body.top_logprobs) && body.top_logprobs >= 0 && body.top_logprobs <= 20, 'Expected an integer between 0 and 20.', 'top_logprobs');
  if (body.user != null) string(body.user, 'user');
  for (const name of ['temperature', 'top_p', 'top_logprobs', 'user', 'parallel_tool_calls']) if (body[name] != null) chat[name] = body[name];
  if (body.top_logprobs != null) chat.logprobs = true;
  if (body.max_output_tokens !== undefined) chat.max_tokens = body.max_output_tokens;
  if (body.reasoning != null) {
    requireValue(object(body.reasoning), 'reasoning must be an object.', 'reasoning');
    if (body.reasoning.effort !== undefined) chat.reasoning_effort = string(body.reasoning.effort, 'reasoning.effort');
  }
  if (body.text != null) {
    requireValue(object(body.text), 'text must be an object.', 'text');
    if (body.text.format !== undefined) {
      const format = body.text.format;
      requireValue(object(format) && ['text', 'json_object', 'json_schema'].includes(format.type), 'Invalid text format.', 'text.format');
      if (format.type === 'json_schema') {
        requireValue(typeof format.name === 'string' && object(format.schema), 'JSON schema requires name and schema.', 'text.format');
        const schema = {};
        for (const field of ['name', 'description', 'schema', 'strict']) if (format[field] !== undefined) schema[field] = format[field];
        chat.response_format = { type: 'json_schema', json_schema: schema };
      } else chat.response_format = { type: format.type };
    }
  }
  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice;
    if (typeof choice === 'string') {
      requireValue(['none', 'auto', 'required'].includes(choice), 'Invalid tool_choice.', 'tool_choice');
      requireValue(choice !== 'required' || tools.length > 0 || searchEnabled, 'No supported tools are available.', 'tool_choice');
      if (tools.length || choice === 'none') chat.tool_choice = choice;
    } else {
      if (object(choice) && searchEnabled && ['web_search', 'web_search_preview'].includes(choice.type)) {
        // Google Search is selected with web_search_options, not a Chat function selector.
      } else {
        requireValue(object(choice) && ['function', 'custom'].includes(choice.type)
          && typeof choice.name === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(choice.name)
          && (choice.namespace == null || typeof choice.namespace === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(choice.namespace)),
        'tool_choice must name a supported tool.', 'tool_choice');
        const name = functionName(choice.name, choice.namespace);
        requireValue(names.has(name), 'tool_choice must name a supported tool.', 'tool_choice');
        requireValue((choice.type === 'custom') === customTools.has(name), 'tool_choice type does not match the tool.', 'tool_choice');
        chat.tool_choice = { type: 'function', function: { name } };
      }
    }
  }
  if (chat.stream) chat.stream_options = { include_usage: true };
  return { chat, customTools, toolNames };
}

function usage(value) {
  if (!object(value)) return null;
  const input = value.prompt_tokens ?? 0;
  const output = value.completion_tokens ?? 0;
  return { input_tokens: input, input_tokens_details: { cached_tokens: value.prompt_tokens_details?.cached_tokens ?? value.prompt_cache_hit_tokens ?? 0 },
    output_tokens: output, output_tokens_details: { reasoning_tokens: value.completion_tokens_details?.reasoning_tokens ?? 0 },
    total_tokens: value.total_tokens ?? input + output };
}

export function responseEnvelope(body) {
  return { id: id('resp'), object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'in_progress',
    error: null, incomplete_details: null, instructions: body.instructions ?? null, max_output_tokens: body.max_output_tokens ?? null,
    model: body.model, output: [], parallel_tool_calls: body.parallel_tool_calls ?? true, previous_response_id: null,
    reasoning: body.reasoning ?? null, store: false, temperature: body.temperature ?? 1, text: body.text ?? { format: { type: 'text' } },
    tool_choice: body.tool_choice ?? 'auto', tools: body.tools ?? [], top_p: body.top_p ?? 1, truncation: 'disabled', usage: null, user: body.user ?? null, metadata: {} };
}

function completeResponse(response, reason, tokenUsage) {
  response.usage = usage(tokenUsage);
  if (reason === 'length' || reason === 'content_filter') {
    response.status = 'incomplete';
    response.incomplete_details = { reason: reason === 'length' ? 'max_output_tokens' : 'content_filter' };
  } else response.status = 'completed';
}

function customInput(argumentsText, incomplete = false) {
  let value;
  try { value = JSON.parse(argumentsText); } catch { /* Handled below without exposing provider content. */ }
  if (!value && incomplete) {
    // A token limit can cut the JSON string in the middle of an escape. Recover
    // only complete string tokens, without leaking the function's JSON wrapper.
    const prefix = argumentsText.match(/^\s*\{\s*"input"\s*:\s*"((?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*)/);
    try { return JSON.parse(`"${prefix?.[1] ?? ''}"`).replace(/[\uD800-\uDBFF]$/, ''); } catch { /* Invalid provider data. */ }
  }
  if (!object(value) || typeof value.input !== 'string') throw new ResponsesError('Upstream returned invalid custom tool arguments.', null, 'upstream_protocol_error', 502);
  return value.input;
}

function callItem(call, customTools, incomplete = false, toolNames = new Map(), providerState) {
  if (typeof call?.id !== 'string' || typeof call.function?.name !== 'string' || typeof call.function.arguments !== 'string') {
    throw new ResponsesError('Upstream returned an invalid tool call.', null, 'upstream_protocol_error', 502);
  }
  const custom = customTools.has(call.function.name);
  const encrypted_content = sealProviderState(call.extra_content,
    { ...providerState, callId: call.id, name: call.function.name });
  return { id: id(custom ? 'ctc' : 'fc'), type: custom ? 'custom_tool_call' : 'function_call', status: incomplete ? 'incomplete' : 'completed',
    call_id: providerCallId(call.id, encrypted_content), ...(toolNames.get(call.function.name) ?? { name: call.function.name }),
    ...(custom ? { input: customInput(call.function.arguments, incomplete) } : { arguments: call.function.arguments }),
    ...(call.extra_content ? { extra_content: call.extra_content } : {}), ...(encrypted_content ? { encrypted_content } : {}) };
}

function choiceOf(value) {
  const choice = value?.choices?.find(choice => choice?.index === 0) ?? value?.choices?.[0];
  if (!object(choice) || !['stop', 'length', 'tool_calls', 'function_call', 'content_filter'].includes(choice.finish_reason)) {
    throw new ResponsesError('Upstream returned an invalid or unfinished completion.', null, 'upstream_protocol_error', 502);
  }
  return choice;
}

export function fromChatResponse(value, body, customTools = new Set(), toolNames = new Map(), providerKey) {
  const choice = choiceOf(value);
  const message = choice.message;
  if (!object(message)) throw new ResponsesError('Upstream returned no message.', null, 'upstream_protocol_error', 502);
  const response = responseEnvelope(body);
  const incomplete = ['length', 'content_filter'].includes(choice.finish_reason);
  const evidence = searchEvidence(message);
  if (evidence) {
    response.output.push(webSearchItem(evidence));
    if (evidence.google) response.google = evidence.google;
  }
  if (message.reasoning_content) response.output.push({ id: id('rs'), type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: message.reasoning_content }] });
  if (typeof message.content === 'string' && message.content.length) response.output.push({ id: id('msg'), type: 'message', status: incomplete ? 'incomplete' : 'completed',
    role: 'assistant', content: [{ type: 'output_text', text: message.content, annotations: citations(message.annotations), logprobs: choice.logprobs?.content ?? [] }],
    ...(message.extra_content ? { extra_content: message.extra_content } : {}) });
  if (typeof message.refusal === 'string' && message.refusal) response.output.push({ id: id('msg'), type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'refusal', refusal: message.refusal }] });
  for (const call of message.tool_calls ?? []) response.output.push(callItem(call, customTools, incomplete, toolNames,
    { key: providerKey, model: body.model }));
  completeResponse(response, choice.finish_reason, value.usage);
  return response;
}

// One accumulator serves both streaming and final response construction. Events are
// drained after each upstream SSE frame so the HTTP writer can apply backpressure.
export class ResponsesStream {
  constructor(body, customTools = new Set(), toolNames = new Map(), providerKey) {
    this.response = responseEnvelope(body);
    this.customTools = customTools;
    this.toolNames = toolNames;
    this.providerState = { key: providerKey, model: body.model };
    this.sequence = 0;
    this.events = [];
    this.calls = new Map();
    this.annotations = new Map();
    this.finished = false;
    this.emit('response.created', { response: this.response });
    this.emit('response.in_progress', { response: this.response });
  }
  emit(type, data) {
    const snapshot = type.endsWith('.delta')
      ? { ...data, ...(data.logprobs ? { logprobs: data.logprobs.length ? structuredClone(data.logprobs) : [] } : {}) }
      : structuredClone(data);
    this.events.push({ type, sequence_number: this.sequence++, ...snapshot });
  }
  drain() { return this.events.splice(0); }
  add(item) {
    const output_index = this.response.output.length;
    this.response.output.push(item);
    this.emit('response.output_item.added', { output_index, item });
    return { item, output_index };
  }
  part(type, text, stateName, extra, logprobs = []) {
    let state = this[stateName];
    if (!state) {
      state = this[stateName] = this.add(type === 'reasoning_text'
        ? { id: id('rs'), type: 'reasoning', summary: [], content: [] }
        : { id: id('msg'), type: 'message', role: 'assistant', status: 'in_progress', content: [] });
      state.item.content.push(type === 'refusal' ? { type, refusal: '' } : { type, text: '', ...(type === 'output_text' ? { annotations: [], logprobs: [] } : {}) });
      this.emit('response.content_part.added', { item_id: state.item.id, output_index: state.output_index, content_index: 0, part: state.item.content[0] });
    }
    if (extra) state.item.extra_content = mergeExtra(state.item.extra_content, extra);
    const field = type === 'refusal' ? 'refusal' : 'text';
    state.item.content[0][field] += text;
    if (type === 'output_text') state.item.content[0].logprobs.push(...logprobs);
    this.emit(`response.${type}.delta`, { item_id: state.item.id, output_index: state.output_index, content_index: 0, delta: text, ...(type === 'output_text' ? { logprobs } : {}) });
  }
  captureSearch(value) {
    const evidence = searchEvidence(value);
    if (!evidence) return;
    if (evidence.google) this.response.google = mergeExtra(this.response.google, evidence.google);
    for (const annotation of evidence.annotations) this.annotations.set(JSON.stringify(annotation), annotation);
    if (!this.search) {
      const item = webSearchItem(evidence);
      item.status = 'in_progress';
      this.search = this.add(item);
      this.emit('response.web_search_call.in_progress', { item_id: item.id, output_index: this.search.output_index });
      this.emit('response.web_search_call.searching', { item_id: item.id, output_index: this.search.output_index });
    }
    const action = this.search.item.action;
    action.queries = [...new Set([...(action.queries ?? []), ...evidence.queries])];
    action.query = action.queries[0] ?? '';
    action.sources = [...new Map([...action.sources, ...evidence.annotations.map(source => ({ type: 'url', url: source.url, title: source.title }))]
      .map(source => [source.url, source])).values()];
  }
  flushAnnotations() {
    if (!this.message || this.annotations.size <= this.message.item.content[0].annotations.length) return;
    const state = this.message;
    const annotations = state.item.content[0].annotations;
    for (const annotation of [...this.annotations.values()].slice(annotations.length)) {
      const annotation_index = annotations.length;
      annotations.push(annotation);
      this.emit('response.output_text.annotation.added', { item_id: state.item.id, output_index: state.output_index,
        content_index: 0, annotation_index, annotation });
    }
  }
  push(chunk) {
    if (!object(chunk) || chunk.error) throw new ResponsesError('Upstream returned a stream error.', null, 'upstream_stream_error', 502);
    if (chunk.usage) this.tokenUsage = chunk.usage;
    const choice = chunk.choices?.find(choice => choice.index === 0);
    if (!choice) return;
    if (this.finishReason) throw new ResponsesError('Upstream sent data after the completion finished.', null, 'upstream_protocol_error', 502);
    const delta = choice.delta ?? {};
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) this.part('reasoning_text', delta.reasoning_content, 'reasoning');
    if (typeof delta.content === 'string' && delta.content) this.part('output_text', delta.content, 'message', delta.extra_content, choice.logprobs?.content ?? []);
    else if (delta.extra_content && this.message) this.message.item.extra_content = mergeExtra(this.message.item.extra_content, delta.extra_content);
    this.captureSearch(delta);
    this.captureSearch(chunk);
    this.flushAnnotations();
    if (typeof delta.refusal === 'string' && delta.refusal) this.part('refusal', delta.refusal, 'refusal');
    for (const call of delta.tool_calls ?? []) {
      if (!Number.isSafeInteger(call.index) || call.index < 0) throw new ResponsesError('Upstream tool call has no valid index.', null, 'upstream_protocol_error', 502);
      let state = this.calls.get(call.index);
      if (!state) { state = { call: { id: '', function: { name: '', arguments: '' } }, emitted: 0 }; this.calls.set(call.index, state); }
      if (call.id) state.call.id = call.id;
      if (call.function?.name) state.call.function.name += call.function.name;
      if (typeof call.function?.arguments === 'string') state.call.function.arguments += call.function.arguments;
      if (call.extra_content) state.call.extra_content = mergeExtra(state.call.extra_content, call.extra_content);
      if (!this.providerState.key && !state.item && state.call.id && state.call.function.name) {
        const custom = this.customTools.has(state.call.function.name);
        Object.assign(state, this.add({ id: id(custom ? 'ctc' : 'fc'), type: custom ? 'custom_tool_call' : 'function_call', status: 'in_progress',
          call_id: state.call.id, ...(this.toolNames.get(state.call.function.name) ?? { name: state.call.function.name }), ...(custom ? { input: '' } : { arguments: '' }) }));
      }
      if (state.item && state.item.type === 'function_call') {
        const text = state.call.function.arguments.slice(state.emitted);
        state.item.arguments += text;
        state.emitted = state.call.function.arguments.length;
        if (text) this.emit('response.function_call_arguments.delta', { item_id: state.item.id, output_index: state.output_index, delta: text });
      }
    }
    if (choice.finish_reason != null) {
      choiceOf({ choices: [choice] });
      this.finishReason = choice.finish_reason;
    }
  }
  finish() {
    if (this.finished) return;
    if (!this.finishReason) throw new ResponsesError('Upstream stream ended without a finish reason.', null, 'upstream_stream_error', 502);
    // Validate every tool before emitting any successful completion events.
    const incomplete = ['length', 'content_filter'].includes(this.finishReason);
    const completedCalls = [...this.calls.values()].map(state => ({ state, item: callItem(state.call, this.customTools, incomplete, this.toolNames, this.providerState) }));
    for (const { state, item } of completedCalls) {
      if (!state.item && this.providerState.key) {
        Object.assign(state, this.add({ ...item, status: 'in_progress', ...(item.type === 'custom_tool_call' ? { input: '' } : { arguments: '' }) }));
        if (item.type === 'function_call') {
          state.item.arguments = item.arguments;
          if (item.arguments) this.emit('response.function_call_arguments.delta', { item_id: item.id, output_index: state.output_index, delta: item.arguments });
        }
      }
      if (!state.item) throw new ResponsesError('Upstream returned an incomplete tool call.', null, 'upstream_protocol_error', 502);
      if (item.type === 'custom_tool_call') {
        state.item.input = item.input;
        if (item.input) this.emit('response.custom_tool_call_input.delta', { item_id: state.item.id, output_index: state.output_index, delta: item.input });
      }
      if (item.extra_content) state.item.extra_content = item.extra_content;
      if (item.encrypted_content) state.item.encrypted_content = item.encrypted_content;
    }
    for (const [output_index, item] of this.response.output.entries()) {
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        const custom = item.type === 'custom_tool_call';
        this.emit(custom ? 'response.custom_tool_call_input.done' : 'response.function_call_arguments.done',
          { item_id: item.id, output_index, [custom ? 'input' : 'arguments']: item[custom ? 'input' : 'arguments'] });
        item.status = incomplete ? 'incomplete' : 'completed';
      } else if (item.type === 'web_search_call') {
        item.status = incomplete ? 'incomplete' : 'completed';
        if (!incomplete) this.emit('response.web_search_call.completed', { item_id: item.id, output_index });
      } else {
        const part = item.content[0];
        this.emit(`response.${part.type}.done`, { item_id: item.id, output_index, content_index: 0,
          [part.type === 'refusal' ? 'refusal' : 'text']: part[part.type === 'refusal' ? 'refusal' : 'text'], ...(part.type === 'output_text' ? { logprobs: part.logprobs } : {}) });
        this.emit('response.content_part.done', { item_id: item.id, output_index, content_index: 0, part });
        if (item.type === 'message') item.status = incomplete ? 'incomplete' : 'completed';
      }
      this.emit('response.output_item.done', { output_index, item });
    }
    completeResponse(this.response, this.finishReason, this.tokenUsage);
    this.emit(`response.${this.response.status}`, { response: this.response });
    this.finished = true;
  }
  fail(code, message) {
    if (this.finished) return;
    this.response.status = 'failed';
    this.response.error = { code, message };
    this.response.usage = usage(this.tokenUsage);
    this.emit('response.failed', { response: this.response });
    this.finished = true;
  }
}
