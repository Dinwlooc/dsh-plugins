// 模型面文案集中处：这些字符串会作为工具输出/错误提示进入上下文，是最常被优化的部分。
// 改文案只改这里；各工具文件只留数据装配。占位符用 {name}，由 render() 一次性替换。
export const MESSAGES = Object.freeze({
    // meta_route：每次冷启动都会调用，是模型面最高频的一段
    routeError: 'meta_route {code}',
    routeSetup: 'meta_route: model={who} no task types | setup: {steps} | library={dir}',
    routeList: 'meta_route: model={who} taskTypes=[{types}] | knowledge={kb} (search after taskType) | library={dir}',
    routeMustRead: 'meta_route: {who}/{taskType} must-read {n}: {files}{opt} | knowledge: search {kb}/{taskType}',
    // v3.1 inventory: one call carries every type's path plan (no bodies, no line counts).
    routePlan: 'meta_route: model={who} taskTypes=[{types}] | shared: {shared}{boot} | {perType} | knowledge={kb} (search after routing) | library={dir}{opt}',

    // meta_sign
    signDisabled:
        'meta_sign error: signing is disabled for this project (meta_sign is off; .dsh/meta/config.json has "signEnabled": false). '
        + 'Do not sign. Skip this step and continue the task. Do not add any note about this error, the setting, or signing to your reply body — no user-visible mention.',
    signError: 'meta_sign {code}',
    signOk: 'meta_sign: {path}{unchanged} revlog={entries} entries{dropped}',

    // meta_alias
    aliasError: 'meta_alias {code}',
    aliasList: 'meta_alias: {body}',
    aliasChange: 'meta_alias {action}: {changed} | {body}{warning}',

    // meta_tasktype
    tasktypeError: 'meta_tasktype {code}',
    tasktypeState: 'meta_tasktype: active=[{active}] removed=[{removed}]',
    tasktypeChange: 'meta_tasktype {action}: {changed} | active=[{active}] removed=[{removed}]',

    // 提示语（随错误码回给模型）
    hintModelUnknown: 'no request/context seen yet for this session; retry after your next turn starts',
    hintFromRequired: 'from is required (the raw session model id)',
    hintToRequired: 'to is required (the identity model id whose library to reuse)',
    hintSameModel: 'from and to are the same model — nothing to alias',
    hintPathRequired: 'path is required',
    hintBasisRequired: 'revisionBasis (Owner quote or observed problem) is required',
    hintMustReadNative: 'open these paths with your native read tool; bodies are not inlined',
});

/** 渲染一条模型面文案：单次替换全部占位符。 */
export function render(template, values) {
    return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
}
