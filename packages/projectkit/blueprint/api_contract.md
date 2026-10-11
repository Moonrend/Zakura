# Project blueprints API

The blueprint format is `Document {schema:"zakura.project-blueprint",version:1,blueprint:Definition}`.
`Definition` has `name,description,projectName,goal,parameters[],tasks[],config`.
Parameters have `name,title,description?,type:string|int|bool|enum|path,required,default?,enum?,minimum?,maximum?,minLength?,maxLength?,pattern?`.
Parameter names, task keys, role names and matrix axis names are ASCII identifiers.
Placeholders are `{{param.NAME}}` and `{{matrix.AXIS}}`, with optional surrounding whitespace. Unknown, malformed or unavailable placeholders fail. Values are inserted once: inserted values are never parsed as templates. Path parameters must be canonical relative workspace paths without globs, backslashes or `..`.

Tasks have `key,title,prompt,agentRole,model?,dependsOn:[{task,matchAxes?:string[]}],writes[],priority,maxAttempts,checks:CheckSpec[],matrix?:Record<string,string[]>,when?:Condition`.
Empty matchAxes selects all expanded upstream tasks; listed axes must exist on both tasks and select equal values. Every declared dependency must select at least one non-skipped upstream instance.
Matrix values can use parameter placeholders. Matrix axes are expanded in lexical order, each value list in author order. Expanded task IDs are stable hashes of the task key and matrix values. A task with no matrix retains its key as ID.
Conditions are exactly one of `{ref:"param.NAME"|"matrix.AXIS",op:"eq"|"ne",value:scalar}`, `{ref,op:"in",values:scalar[]}`, `{ref,op:"present"}`, `{all:Condition[]}`, `{any:Condition[]}`, `{not:Condition}`. No code evaluation or external lookup occurs.

`Inputs {parameters:Record<string,string|number|boolean>,agentMapping:Record<string,string>,spaceId,name?}`. Agent mapping is mandatory for each declared role and is validated against real tenant/space agents for HTTP preview and instantiate. Inputs aren't stored in template records. Instantiation returns a draft project and never starts a run.

Authenticated routes:
- `GET /api/project-templates` → `{items:Template[]}`; `POST /` body `{definition}` → Template.
- `GET /recipes` → `{items:[{id,definition}]}`.
- `POST /preview` body `{definition,...Inputs}` → Expansion.
- `POST /import` body `Document` → Template.
- `GET /{templateId}` → Template; `PATCH /` body `{expectedRevision,definition}` → new immutable version; `DELETE /?expectedRevision=N` → 204.
- `GET /{templateId}/versions` → `{items:TemplateVersion[]}`; `GET /versions/{version}` → TemplateVersion.
- `GET /{templateId}/export?version=N` → Document.
- `POST /{templateId}/preview` and `/instantiate` body `{expectedRevision,version?:number,...Inputs}` → Expansion; instantiate also includes `templateId,templateVersion` and persisted `project`.

Template: `{id,tenantId,revision,currentVersion,definition,createdBy,createdAt,updatedAt}`.
TemplateVersion: `{templateId,version,definition,createdBy,createdAt}`.
Expansion: `{project,analysis,instances:[{taskId,key,axes}],skipped:[...],roles:string[]}`.

Mutations require existing project write authorization and an active tenant. Revision conflicts return 409, inaccessible template/space/agent returns 404, invalid blueprint/inputs return 422 with issues. Authored documents are limited to 2 MiB, expanded output including analysis to 16 MiB, each expanded task to 2 MiB of text, total matrix candidates to 1000, and expanded dependency edges to 100000. Conditions allow depth 8 and 128 nodes. Template values are not intended for secrets; required runtime credentials remain in existing agent/provider configuration.
