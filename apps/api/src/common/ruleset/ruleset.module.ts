import { Global, Module } from '@nestjs/common';
import { RulesetService } from './ruleset.service';

@Global()
@Module({ providers: [RulesetService], exports: [RulesetService] })
export class RulesetModule {}
