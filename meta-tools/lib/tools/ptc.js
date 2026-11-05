// Vendored verbatim from dsh-tool-search 0.1.8 (MIT, author Letter2025).
// Upstream: https://github.com/Letter2025/dsh-tool-search — see ../LICENSE.upstream.
// Local divergence lives in ../tool-search.js (session-frozen manifest), not here.
/**
 * PTC (`run_code`) presentations: the one tool surface this plugin must not
 * transform. `dsh-tools` owns the mode; these helpers read it from the settled
 * assembly, which is the only public surface that carries it.
 * @module dsh-tool-search/ptc
 */
/** The reserved transport tool `dsh-tools` registers for every non-native scope. */
export const PTC_TRANSPORT_TOOL = 'run_code';
/**
 * The `dsh-tools` prompt section whose text states that only `run_code` may be
 * called directly. It renders empty for `native` and `both`, so a non-empty
 * body identifies a strict `ptc` scope.
 */
const PTC_ONLY_SECTION = 'tools:ptc-only';
/**
 * Whether this assembly belongs to a scope that presents tools strictly as
 * generated SDK code. Such a scope sees `assembly.tools` collapsed to the
 * `run_code` transport with every declaration moved into the `tools:sdk`
 * section, so replacing the table would remove `run_code` from the prompt and
 * leave the declarations this plugin exists to slim untouched.
 * @param assembly - the settled assembly from the waterfall chain.
 * @returns true when the scope's presentation mode is `ptc`.
 */
export function isPtcOnlyAssembly(assembly) {
    // Host 0.2.2-rc.1 hands the waterfall only { sections, contexts, variables }:
    // the tool table is merged back AFTER the hook, so both arrays can be absent.
    return (assembly.sections ?? []).some(section => section.name === PTC_ONLY_SECTION && section.text !== '');
}
/**
 * The reserved transport this assembly already declares callable by name.
 * A `both` scope keeps native calls beside code ones, so the transport must
 * survive the surface replacement even though it is never a long-tail tool.
 * @param assembly - the settled assembly from the waterfall chain.
 * @returns the transport name when the assembly declares it, otherwise empty.
 */
export function transportNamesIn(assembly) {
    return (assembly.tools ?? []).some(tool => tool.name === PTC_TRANSPORT_TOOL) ? [PTC_TRANSPORT_TOOL] : [];
}
//# sourceMappingURL=ptc.js.map